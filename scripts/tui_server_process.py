"""Bounded startup and cleanup for the TUI fixture server."""
import json
import os
import select
import subprocess
import time


def server_port(server, timeout=10):
    deadline = time.monotonic() + timeout
    data = bytearray()
    while b'\n' not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([server.stdout], [], [], remaining)[0]:
            raise AssertionError('fake provider startup timed out')
        chunk = os.read(server.stdout.fileno(), 4096)
        if not chunk:
            raise AssertionError('fake provider exited before announcing its port')
        data.extend(chunk)
        if len(data) > 65536:
            raise AssertionError('fake provider startup announcement too large')
    return json.loads(data.split(b'\n', 1)[0])['port']


def stop_server(server, timeout=5):
    server.terminate()
    try:
        server.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=timeout)
