#!/usr/bin/env python3
"""Fault controls for fixture server lifecycle bounds."""
import subprocess
import sys
import time
import unittest
import tempfile
import shutil
from pathlib import Path

sys.dont_write_bytecode = True

from tui_server_process import server_port, stop_server


class ServerProcessTests(unittest.TestCase):
    def test_entrypoint_imports_do_not_write_bytecode(self):
        scripts = Path(__file__).resolve().parent
        entrypoints = ('test-init-cancel-tui.py', 'test-probe-cancel-tui.py', 'test-tui-server-process.py')
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)
            shutil.copy(scripts / 'tui_server_process.py', destination)
            for name in entrypoints:
                source = (scripts / name).read_text()
                prefix = source.split('from tui_server_process import server_port, stop_server', 1)[0]
                (destination / name).write_text(prefix + 'from tui_server_process import server_port, stop_server\n')
                subprocess.run([sys.executable, str(destination / name)], check=True, cwd=destination)
                self.assertFalse((destination / '__pycache__').exists(), name)

    def test_partial_startup_line_times_out(self):
        server = subprocess.Popen([sys.executable, '-u', '-c',
            'import sys,time; sys.stdout.write("{"); sys.stdout.flush(); time.sleep(30)'], stdout=subprocess.PIPE)
        try:
            start = time.monotonic()
            with self.assertRaisesRegex(AssertionError, 'startup timed out'):
                server_port(server, timeout=.2)
            self.assertLess(time.monotonic() - start, 2)
        finally:
            stop_server(server, timeout=2)
            server.stdout.close()

    def test_termination_escalates_to_kill(self):
        server = subprocess.Popen([sys.executable, '-u', '-c',
            'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'], stdout=subprocess.PIPE)
        try:
            self.assertEqual(server.stdout.readline(), b'ready\n')
            start = time.monotonic()
            stop_server(server, timeout=.2)
            self.assertLess(time.monotonic() - start, 2)
            self.assertEqual(server.returncode, -9)
        finally:
            if server.poll() is None:
                server.kill()
                server.wait(timeout=2)
            server.stdout.close()


if __name__ == '__main__':
    unittest.main()
