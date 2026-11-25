#!/usr/bin/env python3
"""Fault controls for fixture server lifecycle bounds."""
import subprocess
import sys
import time
import unittest

from tui_server_process import server_port, stop_server


class ServerProcessTests(unittest.TestCase):
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
