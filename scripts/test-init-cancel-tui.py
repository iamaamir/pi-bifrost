#!/usr/bin/env python3
"""Exercise init catalog cancellation through pinned Pi and a loopback-only provider."""
import importlib.util
import json
import os
import pty
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from tui_server_process import server_port, stop_server

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ui_smoke', ROOT / 'scripts/ui-smoke.py')
ui = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ui
sys.dont_write_bytecode = True
spec.loader.exec_module(ui)

with tempfile.TemporaryDirectory(prefix='bifrost-init-cancel-') as tmp:
    home = Path(tmp)
    work = home / 'work'
    agent = home / '.pi/agent'
    agent.mkdir(parents=True)
    (work / '.pi').mkdir(parents=True)
    report = work / '.pi/bifrost-probe.json'
    original = b'{"fixture":"preexisting bytes"}\n'
    report.write_bytes(original)
    server = subprocess.Popen(['node', str(ROOT / 'scripts/fake-provider-server.mjs')], stdout=subprocess.PIPE, text=True)
    child = None
    master = None
    stop = threading.Event()
    try:
        port = server_port(server)
        (agent / 'models.json').write_text(json.dumps({'providers': {'fake': {'baseUrl': f'http://127.0.0.1:{port}/v1', 'api': 'openai-completions', 'apiKey': 'fixture', 'models': [{'id': 'probe-slow', 'contextWindow': 8192, 'maxTokens': 128}]}}}))
        (agent / 'settings.json').write_text(json.dumps({'retry': {'enabled': False}, 'enabledModels': ['fake/*']}))
        (work / 'bifrost.json').write_text(json.dumps({'enabled': False, 'default': 'general', 'models': {'general': ['fake/probe-slow']}, 'classifier': {'enabled': False}}))
        ui.assert_fake_only_inventory(home, work, agent, port)
        fixture = home / 'delay-refresh.ts'
        fixture.write_text('''export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.modelRegistry.refresh = () => new Promise(() => {});
  });
}''')
        log = home / 'tui.log'
        env = ui.pi_test_environment(home, agent, port)
        env.update({'TERM': 'xterm-256color', 'PI_TUI_WRITE_LOG': str(log)})
        master, slave = pty.openpty()
        ui.set_winsize(master, 12, 48)
        child = subprocess.Popen([ui.PI, '--approve', '--no-session', '--no-tools', '--model', 'fake/probe-slow', '-e', str(ROOT), '-e', str(fixture)], cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        threading.Thread(target=ui.reader, args=(master, stop), daemon=True).start()
        def screen():
            rendered = ui.Screen(48, 12)
            rendered.parse(log.read_text(errors='replace') if log.exists() else '')
            return rendered
        def wait(needle, capture=None):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                rendered = screen()
                text = '\n'.join(rendered.lines())
                if needle in text:
                    if capture:
                        ui.OUT.mkdir(parents=True, exist_ok=True)
                        for row in rendered.rows[-3:]:
                            for cell in row: cell.ch = ' '
                        (ui.OUT / f'{capture}.txt').write_text('\n'.join(rendered.lines()) + '\n')
                        rendered.draw(ui.OUT / f'{capture}.png')
                    return text
                if child.poll() is not None:
                    raise AssertionError(f'Pi exited {child.returncode}: {text}')
                time.sleep(.05)
            raise AssertionError(f"Timeout waiting for {needle}: {' '.join(screen().lines())}")
        wait('Bifrost')
        config = work / 'bifrost.json'
        before = config.read_bytes()
        ui.send(master, '/bifrost init\r')
        progress = wait('Refreshing model catalog', 'init-refresh-narrow')
        first = next(line for line in progress.splitlines() if '◆' in line and '─' in line)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = '\n'.join(screen().lines())
            lines = [line for line in current.splitlines() if '◆' in line and '─' in line]
            if lines and lines[0] != first:
                break
            time.sleep(.05)
        else:
            raise AssertionError('catalog animation did not advance')
        ui.send(master, '\x1b')
        cancelled = wait('configuration was changed.', 'init-cancel-narrow')
        assert config.read_bytes() == before
        assert report.read_bytes() == original
        assert 'Esc to cancel' not in cancelled, cancelled
        violations = home / 'test-network-violations.log'
        assert not violations.exists() or not violations.read_text(), violations.read_text()
        print('PASS: real Pi init catalog animation and cancellation preserve files')
    finally:
        stop.set()
        if child:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        if master is not None: os.close(master)
        stop_server(server)
