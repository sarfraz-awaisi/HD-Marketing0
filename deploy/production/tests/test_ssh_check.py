"""check-ssh.sh and remote.sh's SSH options with throwaway keys; never connects
anywhere (the final connection is replaced by a fake ssh)."""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
HOST = "203.0.113.10"
REAL_SSH = shutil.which("ssh")
FAKE_SSH = """#!/usr/bin/env bash
for arg in "$@"; do [[ "$arg" == -G ]] && exec "$REAL_SSH" "$@"; done
case "$FAKE_SSH_MODE" in
  hostkey) echo "No ED25519 host key is known for $HOST and you have requested strict checking." >&2; echo "Host key verification failed." >&2; exit 255 ;;
  denied) echo "crm-prod@$HOST: Permission denied (publickey)." >&2; exit 255 ;;
  timeout) echo "ssh: connect to host $HOST port 22: Operation timed out" >&2; exit 255 ;;
  *) exit 0 ;;
esac
"""


def keygen(path, kind="ed25519", passphrase=""):
    subprocess.run(["ssh-keygen", "-q", "-t", kind, "-N", passphrase, "-C", "fixture", "-f", str(path)], check=True)
    return path.read_text(), Path(str(path) + ".pub").read_text().split()


def fingerprint(public):
    return subprocess.run(["ssh-keygen", "-l", "-f", "-"], input=" ".join(public[:2]) + "\n",
                          capture_output=True, text=True, check=True).stdout.split()[1]


class Keys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        _, cls.host_ed25519 = keygen(d / "host_ed25519")
        _, cls.host_rsa = keygen(d / "host_rsa", "rsa")
        _, cls.other_ed25519 = keygen(d / "other_ed25519")
        cls.deploy_key, cls.deploy_public = keygen(d / "deploy")
        cls.locked_key, _ = keygen(d / "locked", passphrase="fixture-passphrase")
        cls.trusted = fingerprint(cls.host_ed25519)
        cls.lines = "\n".join(f"{HOST} {k[0]} {k[1]}" for k in (cls.host_ed25519, cls.host_rsa))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()


class CheckSshTests(Keys):
    def check(self, mode=None, **overrides):
        env = {**os.environ, "DEPLOY_HOST": HOST, "DEPLOY_USER": "crm-prod", "TRUSTED_HOST_KEY": self.trusted,
               "SSH_KNOWN_HOSTS": self.lines, "SSH_KEY": self.deploy_key, "SSH_CHECK_CONNECT": "0"}
        env.update(overrides)
        if mode:
            fake = Path(self.tmp.name) / "bin"
            fake.mkdir(exist_ok=True)
            (fake / "ssh").write_text(FAKE_SSH)
            (fake / "ssh").chmod(0o755)
            env.update(PATH=f"{fake}{os.pathsep}{os.environ['PATH']}", REAL_SSH=REAL_SSH, FAKE_SSH_MODE=mode,
                       HOST=HOST, SSH_CHECK_CONNECT="1")
        result = subprocess.run(["bash", str(HERE / "check-ssh.sh")], env=env, capture_output=True, text=True, timeout=60)
        output = result.stdout + result.stderr
        # Never prints private key material.
        for line in self.deploy_key.splitlines()[1:-1]:
            self.assertNotIn(line, output)
        return result.returncode, output

    def test_correct_settings_pass(self):
        code, output = self.check()
        self.assertEqual(code, 0, output)
        self.assertIn(f"ED25519 host key {self.trusted} matches the trusted fingerprint", output)
        self.assertIn(f"deploy key {fingerprint(self.deploy_public)}", output)
        self.assertIn("SSH reads only the DEPLOY_KNOWN_HOSTS keys, with strict host key checking", output)

    def test_formatting_that_still_works(self):
        hashed = Path(self.tmp.name) / "hashed"
        hashed.write_text(self.lines + "\n")
        subprocess.run(["ssh-keygen", "-q", "-H", "-f", str(hashed)], check=True, capture_output=True)
        for label, value in [("windows line endings", self.lines.replace("\n", "\r\n")),
                             ("indented lines", "  " + self.lines.replace("\n", "\n  ")),
                             ("hashed host names", hashed.read_text())]:
            code, output = self.check(SSH_KNOWN_HOSTS=value)
            self.assertEqual(code, 0, f"{label}: {output}")

    def test_names_the_exact_problem(self):
        ed = f"{self.host_ed25519[0]} {self.host_ed25519[1]}"
        cases = [
            ({"SSH_KNOWN_HOSTS": ""}, "DEPLOY_KNOWN_HOSTS secret reached this job empty"),
            ({"SSH_KNOWN_HOSTS": f"  fingerprint {self.trusted} root@srv (ED25519)"}, f"no line for {HOST}"),
            ({"SSH_KNOWN_HOSTS": f"crm.example.org {ed}"}, f"no line for {HOST}"),
            ({"SSH_KNOWN_HOSTS": f"{HOST} {self.host_rsa[0]} {self.host_rsa[1]}"}, "no ssh-ed25519 line"),
            ({"SSH_KNOWN_HOSTS": f"{HOST} {self.other_ed25519[0]} {self.other_ed25519[1]}"},
             f"is {fingerprint(self.other_ed25519)}; the trusted fingerprint is {self.trusted}"),
            ({"TRUSTED_HOST_KEY": ""}, "TRUSTED_HOST_KEY in release.yml is missing"),
            ({"SSH_KEY": ""}, "DEPLOY_SSH_KEY secret reached this job empty"),
            ({"SSH_KEY": self.locked_key}, "not a private key that opens without a passphrase"),
            ({"DEPLOY_USER": "root"}, "DEPLOY_USER variable must be crm-prod"),
            ({"DEPLOY_HOST": ""}, "DEPLOY_HOST variable is missing"),
        ]
        for overrides, message in cases:
            code, output = self.check(**overrides)
            self.assertEqual(code, 1, overrides)
            self.assertIn(message, output, overrides)
        _, output = self.check(SSH_KNOWN_HOSTS=f"  fingerprint {self.trusted} root@srv (ED25519)")
        self.assertIn("Paste the key lines", output)

    def test_test_connection_reports_the_server_side_cause(self):
        for mode, message in [("ok", f"connected to crm-prod@{HOST}"),
                              ("hostkey", "presented a host key that is not in DEPLOY_KNOWN_HOSTS"),
                              ("denied", "refused DEPLOY_SSH_KEY"),
                              ("timeout", "Could not connect")]:
            code, output = self.check(mode=mode)
            self.assertEqual(code, 0 if mode == "ok" else 1, mode)
            self.assertIn(message, output, mode)


class RemoteShTests(Keys):
    def test_uses_only_the_verified_keys_with_strict_checking(self):
        home = Path(self.tmp.name) / "home"
        bindir = Path(self.tmp.name) / "remote-bin"
        bindir.mkdir(exist_ok=True)
        for tool in ("ssh", "scp"):
            (bindir / tool).write_text(f'#!/usr/bin/env bash\nprintf "{tool}' + ' %s\\n" "$*" >> "$FIXTURE_LOG"\n')
            (bindir / tool).chmod(0o755)
        log = Path(self.tmp.name) / "remote.log"
        env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}", "HOME": str(home), "FIXTURE_LOG": str(log),
               "DEPLOY_ENV": "production", "RELEASE_SHA": "a" * 40, "DEPLOY_HOST": HOST, "DEPLOY_USER": "crm-prod",
               "SSH_KEY": self.deploy_key, "SSH_KNOWN_HOSTS": self.lines.replace("\n", "\r\n")}
        result = subprocess.run(["bash", str(HERE / "remote.sh")], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = log.read_text().splitlines()
        self.assertEqual([c.split()[0] for c in calls], ["ssh", "scp", "ssh"])
        known = home / ".ssh" / "known_hosts"
        for call in calls:
            self.assertIn("-o StrictHostKeyChecking=yes", call)
            self.assertIn(f"-o UserKnownHostsFile={known}", call)
            self.assertIn("-o GlobalKnownHostsFile=/dev/null", call)
        self.assertNotIn("\r", known.read_text())
        self.assertEqual(known.read_text(), self.lines + "\n")
        self.assertEqual(stat.S_IMODE((home / ".ssh" / "crm_deploy").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
