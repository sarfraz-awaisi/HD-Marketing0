"""bootstrap-vps.sh and make-server-env.mjs on temporary files only: no root,
no network, no VPS. Fixture values are fake."""
import base64
import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SCRIPT = HERE / 'bootstrap-vps.sh'
GENERATOR = HERE / 'make-server-env.mjs'
PEPPER = 'p' * 40
OTP = 'o' * 40


def bash(snippet, *args):
    """Runs a snippet with the bootstrap functions loaded (main is not run)."""
    return subprocess.run(['bash', '-c', f'source "{SCRIPT}"; {snippet}', 'test', *args],
                          capture_output=True, text=True, timeout=30)


def jwt(role):
    part = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')
    return '.'.join([part({'alg': 'HS256'}), part({'role': role}), 'signature'])


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        match = re.match(r'^([A-Z0-9_]+)=(.*)$', line)
        if match:
            value = match.group(2)
            values[match.group(1)] = value[1:-1] if value[:1] == "'" else value
    return values


class Workspace(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)

    def keypair(self, name='deploy'):
        key = self.dir / name
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', str(key)], check=True)
        return key, Path(str(key) + '.pub')


class AuthorizeKeyTests(Workspace):
    def test_adds_the_key_once_with_restrict_and_keeps_other_lines(self):
        _, public = self.keypair()
        auth = self.dir / 'authorized_keys'
        existing = '# operator key\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExisting admin@laptop'  # no final newline
        auth.write_text(existing)
        first = bash('authorize_key "$1" "$2"', str(public), str(auth))
        second = bash('authorize_key "$1" "$2"', str(public), str(auth))
        self.assertEqual((first.stdout.strip(), second.stdout.strip()), ('added', 'present'), first.stderr)
        lines = auth.read_text().splitlines()
        self.assertEqual(lines[:2], existing.splitlines())
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[2], 'restrict ' + ' '.join(public.read_text().split()[:2]) + ' hd-crm-github-actions')

    def test_rejects_anything_but_one_plain_public_key(self):
        private, public = self.keypair()
        body = ' '.join(public.read_text().split()[:2])
        cases = {
            'private key': private.read_text(),
            'marked private': '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nabc\n',
            'two keys': body + '\n' + body + '\n',
            'options': 'command="sh" ' + body + '\n',
            'unknown type': 'ssh-dss AAAAB3NzaC1kc3MAAACBA\n',
            'malformed': 'ssh-ed25519 not*base64\n',
        }
        for label, text in cases.items():
            candidate = self.dir / 'candidate.pub'
            candidate.write_text(text)
            auth = self.dir / 'authorized_keys'
            result = bash('authorize_key "$1" "$2"', str(candidate), str(auth))
            self.assertNotEqual(result.returncode, 0, label)
            self.assertFalse(auth.exists(), label)


class RenderSiteTests(unittest.TestCase):
    def render(self, *extra):
        result = subprocess.run(['bash', str(SCRIPT), '--print-site', '--domain', 'crm.example.org', *extra],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_renders_the_template_for_the_domain(self):
        site = self.render()
        template = (HERE / 'site.conf.example').read_text()
        self.assertNotIn('crm.example.com', site)
        self.assertNotIn('www.', site)
        self.assertIn('server_name crm.example.org;', site)
        self.assertIn('/etc/letsencrypt/live/crm.example.org/fullchain.pem', site)
        # Every template directive is kept; only the host name changes.
        for line in template.splitlines()[1:]:
            self.assertIn(line.replace('crm.example.com', 'crm.example.org'), site)

    def test_www_redirects_to_the_main_address(self):
        site = self.render('--redirect-www')
        www = site[site.index('# www.crm.example.org'):]
        self.assertEqual(www.count('server_name www.crm.example.org;'), 2)
        self.assertEqual(www.count('return 301 https://crm.example.org$request_uri;'), 2)
        self.assertIn('location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }', www)
        self.assertNotIn('include', www)


class ArgumentTests(Workspace):
    def run_script(self, *args):
        return subprocess.run(['bash', str(SCRIPT), *args], capture_output=True, text=True, timeout=30)

    def test_rejects_bad_input_before_doing_anything(self):
        private, _ = self.keypair()
        for args in (['--domain', 'Not A Domain'], ['--domain', 'example.com', '--deploy-host', 'x;rm'],
                     ['--domain', 'example.com', '--deploy-key', str(private)],
                     ['--domain', 'example.com', '--server-env', str(self.dir / 'missing')], ['--unknown']):
            self.assertEqual(self.run_script(*args).returncode, 2, args)

    def test_needs_root_on_linux_except_for_print_site(self):
        if os.geteuid() == 0:
            self.skipTest('running as root')
        result = self.run_script('--domain', 'example.com')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Run with sudo on the Ubuntu VPS', result.stderr)


class SafetyTests(unittest.TestCase):
    def test_never_touches_traffic_ssh_firewall_docker_or_the_database(self):
        code = '\n'.join(line for line in SCRIPT.read_text().splitlines() if not line.lstrip().startswith('#'))
        forbidden = {
            # A call, not the sudoers rule that names the helper.
            'release or slot switch': r'release\.sh\'?"?\s+(deploy|rollback)|(^\s*|[;&|(]\s*|sudo\s+)("?\$HELPER"?|\S*hd-crm-switch)\s+(production|staging)',
            'process changes': r'pm2 (start|stop|delete|restart|kill|reload)\b',
            'SSH settings': r'(>|tee|sed -i|cp|mv|install)[^\n]*sshd_config|systemctl (reload|restart) (ssh|sshd)',
            'firewall changes': r'ufw (allow|deny|enable|disable|delete|reset)|iptables',
            'Docker changes': r'docker (rm|stop|kill|volume|system|compose|run|start|restart|network)',
            'database access': r'psql|pg_restore|supabase (db|migration)',
            'key removal': r'(rm|sed -i|truncate)[^\n]*authorized_keys',
        }
        for label, pattern in forbidden.items():
            self.assertIsNone(re.search(pattern, code, re.M), label)
        # The guard itself catches a call.
        for call in ('  "$HELPER" production abc blue', 'bash "$BASE/x/deploy/production/release.sh" deploy production'):
            self.assertIsNotNone(re.search(forbidden['release or slot switch'], call, re.M), call)


class ServerEnvTests(Workspace):
    def source(self, **overrides):
        values = {
            'SUPABASE_URL': 'https://abcdefghijklmnopqrst.supabase.co',
            'SUPABASE_SERVICE_ROLE_KEY': 'fixture-service-role-key-not-real',
            'ACCOUNTS_PIN_PEPPER': PEPPER, 'ACCOUNT_OTP_SECRET': OTP,
            'ACCOUNT_SMTP_PASSWORD': "'pass word#1'",
            'FRONTEND_URL': 'http://localhost:5173', 'CALL_PROVIDER': 'mock', 'PORT': '3001',
            'NODE_ENV': 'development', 'DEV_ADMIN_PASSWORD': 'dev-password-fixture',
            'VITE_SUPABASE_URL': 'https://abcdefghijklmnopqrst.supabase.co', 'STALE_LEAD_DAYS': '7',
        }
        values.update(overrides)
        path = self.dir / 'source.env'
        path.write_text(''.join(f'{k}={v}\n' for k, v in values.items() if v is not None))
        return path

    def generate(self, source, out=None):
        out = out or self.dir / 'server.env'
        result = subprocess.run(['node', str(GENERATOR), '--domain', 'crm.example.org', '--from', str(source), '--out', str(out)],
                                capture_output=True, text=True, timeout=60)
        return result, out

    def test_builds_production_settings_without_printing_values(self):
        result, out = self.generate(self.source())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        env = read_env(out)
        self.assertEqual({k: env[k] for k in ('NODE_ENV', 'FRONTEND_URL', 'CALL_PROVIDER', 'TRUST_PROXY')},
                         {'NODE_ENV': 'production', 'FRONTEND_URL': 'https://crm.example.org',
                          'CALL_PROVIDER': 'manual', 'TRUST_PROXY': 'loopback'})
        self.assertEqual((env['ACCOUNTS_PIN_PEPPER'], env['ACCOUNT_OTP_SECRET']), (PEPPER, OTP))
        self.assertEqual(env['ACCOUNT_SMTP_PASSWORD'], 'pass word#1')
        self.assertRegex(env['WEBHOOK_SECRET'], r'^[0-9a-f]{64}$')
        for key in ('PORT', 'DEV_ADMIN_PASSWORD', 'VITE_SUPABASE_URL', 'STALE_LEAD_DAYS'):
            self.assertNotIn(key, env)
        for secret in (PEPPER, OTP, 'fixture-service-role-key-not-real', 'pass word#1', env['WEBHOOK_SECRET']):
            self.assertNotIn(secret, result.stdout + result.stderr)
        # The bootstrap check on the VPS accepts exactly what the generator writes.
        check = bash('check_server_env "$1" crm.example.org', str(out))
        self.assertEqual((check.returncode, check.stdout), (0, '\n'), check.stderr)

    def test_dry_run_checks_everything_and_writes_nothing(self):
        out = self.dir / 'dry.env'
        result = subprocess.run(['node', str(GENERATOR), '--domain', 'crm.example.org', '--from', str(self.source()),
                                 '--out', str(out), '--dry-run'], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('nothing written', result.stdout)
        self.assertFalse(out.exists())
        bad = subprocess.run(['node', str(GENERATOR), '--domain', 'crm.example.org', '--dry-run',
                              '--from', str(self.source(ACCOUNTS_PIN_PEPPER='short'))], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)

    def test_never_overwrites_and_keeps_a_long_webhook_secret(self):
        _, out = self.generate(self.source(WEBHOOK_SECRET='w' * 40))
        self.assertEqual(read_env(out)['WEBHOOK_SECRET'], 'w' * 40)
        before = out.read_text()
        again, _ = self.generate(self.source(), out)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(out.read_text(), before)

    def test_refuses_settings_the_api_would_reject(self):
        cases = {
            'short pepper': {'ACCOUNTS_PIN_PEPPER': 'short'},
            'anon key as service key': {'SUPABASE_SERVICE_ROLE_KEY': jwt('anon')},
            'trailing slash': {'SUPABASE_URL': 'https://abcdefghijklmnopqrst.supabase.co/'},
            'missing service key': {'SUPABASE_SERVICE_ROLE_KEY': None},
        }
        for label, overrides in cases.items():
            out = self.dir / f'{label}.env'
            result, _ = self.generate(self.source(**overrides), out)
            self.assertNotEqual(result.returncode, 0, label)
            self.assertIn('Not written', result.stderr, label)
            self.assertFalse(out.exists(), label)
            self.assertNotIn(PEPPER, result.stderr)

    def test_bootstrap_check_names_problems_without_values(self):
        bad = self.dir / 'bad.env'
        bad.write_text(f'NODE_ENV=production\nFRONTEND_URL=https://other.example\nSUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\n'
                       f'SUPABASE_SERVICE_ROLE_KEY={jwt("anon")}\nACCOUNTS_PIN_PEPPER=short-pepper\nWEBHOOK_SECRET={"w" * 40}\n'
                       'CALL_PROVIDER=mock\nDEV_ADMIN_PASSWORD=dev-password-fixture\n')
        check = bash('check_server_env "$1" crm.example.org', str(bad))
        self.assertEqual(check.returncode, 1)
        for name in ('FRONTEND_URL', 'ACCOUNTS_PIN_PEPPER', 'CALL_PROVIDER', 'DEV_ADMIN_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY'):
            self.assertIn(name, check.stdout)
        for value in ('short-pepper', 'dev-password-fixture', 'other.example', 'w' * 40):
            self.assertNotIn(value, check.stdout)

    def test_installed_pin_and_code_secrets_are_preserved(self):
        old, new = self.dir / 'old.env', self.dir / 'new.env'
        old.write_text(f'ACCOUNTS_PIN_PEPPER={PEPPER}\nACCOUNT_OTP_SECRET={OTP}\n')
        new.write_text(f'ACCOUNTS_PIN_PEPPER={PEPPER}\nACCOUNT_OTP_SECRET={OTP}\nWEBHOOK_SECRET={"w" * 40}\n')
        self.assertEqual(bash('preserved_secrets_match "$1" "$2"', str(old), str(new)).returncode, 0)
        new.write_text(f'ACCOUNTS_PIN_PEPPER={"q" * 40}\nACCOUNT_OTP_SECRET={OTP}\n')
        self.assertEqual(bash('preserved_secrets_match "$1" "$2"', str(old), str(new)).returncode, 1)


if __name__ == '__main__':
    unittest.main()
