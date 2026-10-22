import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("switch", Path(__file__).parents[1] / "switch.py")
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)
class SwitchTests(unittest.TestCase):
    def test_strict_targets(self):
        for args in [("other", "a"*40, "blue"), ("production", "../etc", "blue"), ("staging", "a"*40, "red")]:
            with self.assertRaises(ValueError): switch.render(*args)
    def test_ports_and_assets(self):
        for env, port in [("production",3101),("staging",3201)]:
            for slot, delta in [("blue",0),("green",1)]:
                result=switch.render(env,"a"*40,slot)
                self.assertIn(f"127.0.0.1:{port+delta}",result)
                self.assertIn(f"/srv/hd-crm/{env}/assets/",result)
                self.assertIn("proxy_next_upstream off",result)
    def test_failed_validation_or_reload_restores_previous(self):
        for failure in [1,2]:
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/"active.conf"
                path.write_text("old")
                calls=[]
                def run(args, **kwargs):
                    calls.append(args)
                    if len(calls)==failure: raise subprocess.CalledProcessError(1,args)
                with self.assertRaises(subprocess.CalledProcessError): switch.switch(path,"new",run)
                self.assertEqual(path.read_text(),"old")
                self.assertEqual(calls[-1], ["/bin/systemctl","reload","nginx"])
    def test_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"active.conf"; path.write_text("old")
            switch.switch(path,"new",lambda *a,**k: None)
            self.assertEqual(path.read_text(),"new")
