#!/usr/bin/python3
"""Install root-owned at /usr/local/sbin/hd-crm-switch. Never sudo repository scripts."""
import os, re, subprocess, sys, tempfile
from pathlib import Path

def render(environment, sha, slot):
    if environment not in ("production", "staging") or slot not in ("blue", "green") or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid switch arguments")
    if sha == "0" * 40:
        return "location / { return 503; }\n"
    port = (3101 if environment == "production" else 3201) + (slot == "green")
    root = f"/srv/hd-crm/{environment}"
    return f"""# {slot} {sha}
root {root}/releases/{sha}/client/dist;
location / {{ try_files $uri $uri/ /index.html; add_header Cache-Control "no-store" always; add_header X-Content-Type-Options nosniff always; add_header X-Frame-Options SAMEORIGIN always; add_header Strict-Transport-Security "max-age=31536000" always; }}
location /assets/ {{ alias {root}/assets/; add_header Cache-Control "public, max-age=31536000, immutable"; add_header X-Content-Type-Options nosniff always; add_header Strict-Transport-Security "max-age=31536000" always; }}
location = /ready {{ deny all; }}
location = /health {{ proxy_pass http://127.0.0.1:{port}; }}
location /api/ {{
    limit_req zone=crm_api burst=200 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:{port};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_next_upstream off;
}}
"""

def atomic(path, content):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".switch-")
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(name, 0o644)
    os.replace(name, path)

def switch(path, content, run=subprocess.run):
    previous = path.read_text()
    atomic(path, content)
    try:
        run(["/usr/sbin/nginx", "-t"], check=True)
        run(["/bin/systemctl", "reload", "nginx"], check=True)
    except BaseException:
        atomic(path, previous)
        run(["/usr/sbin/nginx", "-t"], check=True)
        run(["/bin/systemctl", "reload", "nginx"], check=True)
        raise

if __name__ == "__main__":
    if os.geteuid() != 0 or len(sys.argv) != 4:
        sys.exit("Usage (root): hd-crm-switch production|staging SHA blue|green")
    environment, sha, slot = sys.argv[1:]
    expected_user = "crm-prod" if environment == "production" else "crm-stage"
    caller = os.environ.get("SUDO_USER", "root")
    if caller in ("crm-prod", "crm-stage") and caller != expected_user:
        sys.exit("Deployment account cannot switch this environment")
    content = render(environment, sha, slot)
    # Kernel lock also serializes switches from different environment workflows.
    import fcntl
    with open("/run/lock/hd-crm-nginx.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        switch(Path(f"/etc/nginx/hd-crm/{environment}.conf"), content)
