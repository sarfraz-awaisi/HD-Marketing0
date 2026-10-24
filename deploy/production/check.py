#!/usr/bin/env python3
"""Local/CI checks. Prints filenames only, never detected secret contents."""
import ast, base64, json, re, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[2]
errors = []
for folder in ("server/src", "deploy/production"):
    for file in (root / folder).rglob("*"):
        if file.suffix in (".js", ".mjs", ".cjs"):
            subprocess.run(["node", "--check", str(file)], check=True)
        elif file.suffix == ".py":
            ast.parse(file.read_text(), filename=str(file))
        elif file.suffix == ".sh":
            subprocess.run(["bash", "-n", str(file)], check=True)
tracked = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
for name in filter(None, tracked):
    file = root / name
    if not file.is_file(): continue
    if (file.name.startswith(".env") or file.name.endswith(".env")) and not file.name.endswith(".example"):
        errors.append(name + ": private environment file tracked")
    try: text = file.read_text()
    except UnicodeDecodeError: continue
    if re.search(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----", text):
        errors.append(name + ": private key marker")
    if re.search(r"sb_secret_[A-Za-z0-9_-]{20,}", text):
        errors.append(name + ": privileged key pattern")
    for token in re.findall(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", text):
        try:
            payload = token.split(".")[1]
            if json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("role") == "service_role":
                errors.append(name + ": privileged JWT")
        except (ValueError, UnicodeError): pass
for name in ("release.sh", "remote.sh"):
    text = (root / "deploy/production" / name).read_text()
    if re.search(r"supabase\s+db|psql|pg_restore|setup:dev|supabase/setup|supabase/seed", text):
        errors.append(name + ": forbidden database deployment command")
# The deployment SSH connection always verifies the server against the
# reviewed host keys (comments, which explain the rule, are not checked).
for name in ("remote.sh", "check-ssh.sh"):
    code = "\n".join(line for line in (root / "deploy/production" / name).read_text().splitlines() if not line.lstrip().startswith("#"))
    if re.search(r"StrictHostKeyChecking=(no|off|accept-new)|UserKnownHostsFile=/dev/null|ssh-keyscan", code, re.I):
        errors.append(name + ": weakens SSH host key verification")
# Deployments are manual, production-only and gated on CI (workflow_policy.py).
from workflow_policy import errors as workflow_errors
errors += workflow_errors({file.name: file.read_text() for file in (root / ".github/workflows").glob("*.y*ml")})
if errors: raise SystemExit("\n".join(sorted(set(errors))))
print("Server/deployment syntax, credential-pattern and release-workflow policy checks passed")
