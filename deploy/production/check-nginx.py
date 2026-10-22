#!/usr/bin/env python3
"""Validate real templates with temporary certificates; never start/reload Nginx.
Runs as an unprivileged user: only file locations move into the temporary
folder, and every directive in the templates is still checked."""
import importlib.util
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent
nginx = shutil.which('nginx')
if not nginx:
    raise SystemExit('Nginx is not installed; validate on Ubuntu before launch')
spec = importlib.util.spec_from_file_location('crm_switch', root / 'switch.py')
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)
# Temporary folders compiled into the build (Ubuntu: /var/lib/nginx/...) need root.
build = subprocess.run([nginx, '-V'], capture_output=True, text=True).stderr
temp_paths = re.findall(r'--http-([a-z-]+)-temp-path=', build)
with tempfile.TemporaryDirectory() as temporary:
    folder = Path(temporary)
    (folder / 'logs').mkdir()
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(folder / 'key.pem'), '-out', str(folder / 'cert.pem'),
                    '-days', '1', '-subj', '/CN=crm.example.com'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    site = (root / 'site.conf.example').read_text()
    site = site.replace('/etc/letsencrypt/live/crm.example.com/fullchain.pem', str(folder / 'cert.pem'))
    site = site.replace('/etc/letsencrypt/live/crm.example.com/privkey.pem', str(folder / 'key.pem'))
    site = site.replace('/etc/nginx/hd-crm/production.conf', str(folder / 'active.conf'))
    site = site.replace('/var/log/nginx/crm-production-access.log', str(folder / 'access.log'))
    site = site.replace('/var/log/nginx/crm-production-error.log', str(folder / 'error.log'))
    # Test-only defaults, used where the templates set none (Ubuntu's own
    # nginx.conf provides them on the server): the port-80 server's access log
    # and the temporary folders.
    test_only = 'access_log ' + str(folder / 'logs' / 'access.log') + ';\n'
    test_only += ''.join(name.replace('-', '_') + '_temp_path ' + str(folder / name) + ';\n' for name in temp_paths)
    config = folder / 'nginx.conf'
    config.write_text('error_log stderr;\npid ' + str(folder / 'nginx.pid') + ';\nlock_file '
                      + str(folder / 'nginx.lock') + ';\nevents {}\nhttp {\n' + test_only
                      + (root / 'nginx.conf.example').read_text() + '\n' + site + '\n}\n')
    test = [nginx, '-t', '-p', str(folder) + '/', '-c', str(config)]
    for environment in ('production', 'staging'):
        for slot in ('blue', 'green'):
            (folder / 'active.conf').write_text(switch.render(environment, 'a' * 40, slot))
            subprocess.run(test, check=True)
    # The relocations must not hide real mistakes: a bad directive still fails.
    (folder / 'active.conf').write_text(switch.render('production', 'a' * 40, 'blue') + 'not_a_directive on;\n')
    broken = subprocess.run(test, capture_output=True, text=True)
    if broken.returncode == 0 or 'unknown directive "not_a_directive"' not in broken.stderr:
        raise SystemExit('Nginx check did not reject an invalid directive:\n' + broken.stderr)
print('All Nginx slot templates passed syntax validation; an invalid directive was rejected')
