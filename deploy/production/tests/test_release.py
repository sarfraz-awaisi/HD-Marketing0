"""Run real orchestration against fake executables; never use network, PM2 or sudo."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'release.sh'
OLD = 'a' * 40
NEW = 'b' * 40
DISPATCH = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
root=Path(os.environ['FIXTURE'])
mode=os.environ.get('FAIL_MODE','')
with (root/'commands').open('a') as out: out.write(name+' '+ ' '.join(args)+'\\n')
if name=='flock' and mode=='locked': sys.exit(1)
if name=='pm2' and args[0]=='describe': sys.exit(0 if mode=='occupied' else 1)
if name=='npm' and mode=='install': sys.exit(1)
if name=='node' and args[0].endswith('health.mjs'):
    countfile=root/'health-count'
    count=int(countfile.read_text())+1 if countfile.exists() else 1
    countfile.write_text(str(count))
    if mode=='health' or (mode=='monitor' and count>1): sys.exit(1)
if name=='curl' and '-D' in args:
    Path(args[args.index('-D')+1]).write_text('HTTP/1.1 200 OK\\r\\nX-Release-SHA: '+os.environ['TARGET_SHA']+'\\r\\n')
if name=='sudo':
    with (root/'switches').open('a') as out: out.write(' '.join(args[1:])+'\\n')
'''

class ReleaseTests(unittest.TestCase):
    def scenario(self, mode='', rollback=False, first=False):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root=Path(directory.name)
        base=root/'production'; base.mkdir()
        for sha in [OLD,NEW]:
            release=base/'releases'/sha
            (release/'client/dist/assets').mkdir(parents=True)
            (release/'client/dist/index.html').write_text('fixture')
            (release/'client/dist/assets/test.js').write_text('fixture')
            (release/'RELEASE_SHA').write_text(sha)
        if not first: (base/'active').write_text(f'blue {OLD}\n')
        (base/'origin').write_text('https://fixture.invalid')
        if rollback: (base/'previous').write_text(f'green {NEW}\n')
        bindir=root/'bin'; bindir.mkdir()
        for command in ['flock','npm','pm2','node','sudo','curl','sleep']:
            file=bindir/command; file.write_text(DISPATCH); file.chmod(0o755)
        env={**os.environ,'PATH':str(bindir)+os.pathsep+os.environ['PATH'],
             'HD_CRM_ROOT':str(root),'FIXTURE':str(root),'FAIL_MODE':mode,'TARGET_SHA':NEW}
        result=subprocess.run(['bash',str(SCRIPT),'rollback' if rollback else 'deploy','production',NEW],
                              env=env,capture_output=True,text=True,timeout=20)
        switches=(root/'switches').read_text() if (root/'switches').exists() else ''
        return result, base, switches

    def test_success_keeps_previous(self):
        result,base,switches=self.scenario()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((base/'active').read_text(),f'green {NEW}\n')
        self.assertEqual((base/'previous').read_text(),f'blue {OLD}\n')
        self.assertEqual(switches,f'production {NEW} green\n')
    def test_failures_before_switch_leave_active(self):
        for mode in ['health','install','occupied','locked']:
            result,base,switches=self.scenario(mode)
            self.assertNotEqual(result.returncode,0,mode)
            self.assertEqual((base/'active').read_text(),f'blue {OLD}\n')
            self.assertEqual(switches,'')
    def test_monitor_failure_rolls_back(self):
        result,base,switches=self.scenario('monitor')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((base/'active').read_text(),f'blue {OLD}\n')
        self.assertEqual(switches,f'production {NEW} green\nproduction {OLD} blue\n')
    def test_first_release_failure_returns_to_maintenance(self):
        result,base,switches=self.scenario('monitor',first=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((base/'active').exists())
        self.assertIn('production '+'0'*40+' blue\n',switches)
    def test_manual_rollback_uses_same_validation(self):
        result,base,switches=self.scenario(rollback=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((base/'active').read_text(),f'green {NEW}\n')
        self.assertEqual((base/'previous').read_text(),f'blue {OLD}\n')
