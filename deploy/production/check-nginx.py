#!/usr/bin/env python3
"""Validate real templates with temporary certificates; never start/reload Nginx."""
import importlib.util
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
    config = folder / 'nginx.conf'
    config.write_text('error_log stderr;\npid ' + str(folder / 'nginx.pid') + ';\nevents {}\nhttp {\n'
                      + (root / 'nginx.conf.example').read_text() + '\n' + site + '\n}\n')
    for environment in ('production', 'staging'):
        for slot in ('blue', 'green'):
            (folder / 'active.conf').write_text(switch.render(environment, 'a' * 40, slot))
            subprocess.run([nginx, '-t', '-p', str(folder) + '/', '-c', str(config)], check=True)
print('All Nginx slot templates passed syntax validation')
