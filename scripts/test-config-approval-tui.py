#!/usr/bin/env python3
"""Pinned-Pi viewport regression. Isolated files; no generation or external network."""
import importlib.util
import json
import os
import pty
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("BIFROST_TEST_APPROVAL_ROOT", REPO))
spec = importlib.util.spec_from_file_location("bifrost_ui_smoke", REPO / "scripts/ui-smoke.py")
assert spec is not None and spec.loader is not None
ui = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ui
sys.dont_write_bytecode = True
spec.loader.exec_module(ui)


class ViewportScreen(ui.Screen):
    """VT autowrap is delayed until next printable character, not after last cell."""
    def put(self, ch):
        if ch in ("\n", "\r", "\b", "\t"):
            return super().put(ch)
        if self.col >= self.width:
            self.newline()
        if 0 <= self.row < self.height and 0 <= self.col < self.width:
            self.rows[self.row][self.col] = ui.Cell(ch=ch, fg=self.fg, bg=self.bg)
        self.col += 1


def run():
    with tempfile.TemporaryDirectory(prefix="bifrost-approval-tui-") as temp:
        home = Path(temp)
        work = home / "work"
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        (work / ".pi").mkdir(parents=True)
        original = json.dumps({"enabled": False, "default": "general", "models": {"general": ["fake/healthy"]}, "classifier": {"enabled": False}})
        source = work / ".pi/bifrost.json"
        source.write_text(original)
        (agent / "models.json").write_text(json.dumps({"providers": {"fake": {"baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions", "apiKey": "fixture-only", "models": [{"id": "healthy", "contextWindow": 8192, "maxTokens": 128}]}}}))
        (agent / "settings.json").write_text(json.dumps({"retry": {"enabled": False}, "enabledModels": ["fake/*"]}))
        log = home / "tui.log"
        result = work / "approval-result.json"
        env = ui.pi_test_environment(home, agent, 1)
        env.update({"TERM": "xterm-256color", "PI_TUI_WRITE_LOG": str(log)})
        master, slave = pty.openpty()
        width, height = 48, 12
        ui.set_winsize(master, height, width)
        child = subprocess.Popen([ui.PI, "--approve", "--no-session", "--no-tools", "--model", "fake/healthy", "-e", str(ROOT), "-e", str(ROOT / "tests/fixtures/config-approval-extension.ts")], cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        stop = threading.Event()
        reader = threading.Thread(target=ui.reader, args=(master, stop), daemon=True)
        reader.start()

        def screen():
            rendered = ViewportScreen(width, height)
            rendered.parse(log.read_text(errors="replace") if log.exists() else "")
            return "\n".join(rendered.lines())

        def wait(predicate, label):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                text = screen()
                if predicate(text):
                    return text
                if child.poll() is not None:
                    raise AssertionError(f"Pi exited: {child.returncode}\n{text}")
                time.sleep(0.05)
            raise AssertionError(f"Timeout: {label}\n{screen()}")

        def unchanged():
            assert source.read_text() == original, "unreviewed proposal wrote source"
            assert not result.exists(), "approval finished before explicit final Apply"

        def page(text):
            found = re.search(r"Bifrost review (\d+)/(\d+)", text)
            return (int(found[1]), int(found[2])) if found else (0, 0)

        def traverse():
            seen = []
            for _ in range(100):
                text = wait(lambda s: page(s)[0] > 0, "review page")
                current, total = page(text)
                seen.append(text)
                unchanged()
                if current == total:
                    assert "a Apply" in text, text
                    return "\n".join(seen)
                ui.send(master, "n")
                wait(lambda s, expected=(current + 1, total): page(s) == expected, "next rendered page")
            raise AssertionError("review did not end")

        def start_case():
            ui.send(master, "/approval-case")
            wait(lambda s: "/approval-case" in s, "command in editor")
            ui.send(master, "\r")

        try:
            wait(lambda s: "Bifrost" in s and "healthy" in s, "Pi startup")
            start_case()
            wait(lambda s: "Apply this Bifrost configuration?" in s, "approval surface")
            ui.send(master, "\r")
            time.sleep(0.2)
            unchanged()
            initial = wait(lambda s: page(s)[0] > 0, "first review")
            assert page(initial)[0] == 1 and page(initial)[1] > 1, initial
            assert "HIDDEN_LAST_CHANGE" not in initial, initial
            ui.send(master, "a\r")
            time.sleep(0.2)
            unchanged()
            # Cancel is never approval, even after the final page was displayed.
            seen = traverse()
            assert "HIDDEN_LAST_CHANGE" in seen.replace("\n", ""), seen
            ui.send(master, "\x1b")
            wait(lambda _: result.exists(), "cancel result")
            assert json.loads(result.read_text())["status"] == "declined"
            assert source.read_text() == original
            result.unlink()
            start_case()
            wait(lambda s: page(s)[0] == 1, "second review")
            traverse()
            # Shrinking to a tiny terminal must revoke final-page approval.
            width, height = 35, 6
            ui.set_winsize(master, height, width)
            os.kill(child.pid, signal.SIGWINCH)
            wait(lambda s: "Resize to 40x8" in s, "tiny viewport")
            ui.send(master, "a")
            time.sleep(0.2)
            unchanged()
            width, height = 40, 9
            ui.set_winsize(master, height, width)
            os.kill(child.pid, signal.SIGWINCH)
            wait(lambda s: page(s)[0] == 1, "resize reset")
            ui.send(master, "a")
            time.sleep(0.2)
            unchanged()
            seen = traverse()
            assert "HIDDEN_LAST_CHANGE" in seen.replace("\n", ""), seen
            ui.send(master, "a")
            wait(lambda _: result.exists(), "apply result")
            assert json.loads(result.read_text())["status"] == "ok"
            saved = json.loads(source.read_text())
            expected = json.loads(original)
            expected["description"] = "x" * 900 + "HIDDEN_LAST_CHANGE"
            assert saved == expected
            ui.assert_no_network_violations(home)
            print("PASS: pinned Pi paged review, early Apply refusal, cancel, tiny viewport, resize reset, exact write")
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            os.close(master)
            reader.join(timeout=2)


if __name__ == "__main__":
    run()
