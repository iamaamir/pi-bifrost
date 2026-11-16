#!/usr/bin/env python3
"""Real Pi PTY acceptance for the cost overlay; synthetic data, no generation."""
import importlib.util
import os
import pty
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bifrost_ui_smoke", REPO / "scripts/ui-smoke.py")
assert spec is not None and spec.loader is not None
ui = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ui
sys.dont_write_bytecode = True
spec.loader.exec_module(ui)


class ViewportScreen(ui.Screen):
    def put(self, ch):
        if ch in ("\n", "\r", "\b", "\t"):
            return super().put(ch)
        if self.col >= self.width:
            self.newline()
        if 0 <= self.row < self.height and 0 <= self.col < self.width:
            self.rows[self.row][self.col] = ui.Cell(ch=ch, fg=self.fg, bg=self.bg)
        self.col += 1


def run():
    temp = Path(tempfile.mkdtemp(prefix="bifrost-cost-tui-"))
    child = None
    master = None
    stop = threading.Event()
    reader = None
    home = temp
    agent = home / ".pi/agent"
    work = home / "work"
    agent.mkdir(parents=True)
    work.mkdir()
    (agent / "models.json").write_text('{"providers":{}}\n')
    (agent / "settings.json").write_text('{"retry":{"enabled":false}}\n')
    log = home / "tui.log"
    env = ui.pi_test_environment(home, agent, 1)
    env.update({"TERM": "xterm-256color", "PI_TUI_WRITE_LOG": str(log)})
    master, slave = pty.openpty()
    width, height = 80, 24
    ui.set_winsize(master, height, width)
    child = subprocess.Popen([ui.PI, "--no-session", "--no-tools", "-e", str(REPO), "-e", str(REPO / "tests/fixtures/cost-view-extension.ts")], cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    reader = threading.Thread(target=ui.reader, args=(master, stop), daemon=True)
    reader.start()

    def screen():
        parsed = ViewportScreen(width, height)
        parsed.parse(log.read_text(errors="replace") if log.exists() else "")
        return "\n".join(parsed.lines())

    def assert_overlay_frame(label):
        parsed = ViewportScreen(width, height)
        parsed.parse(log.read_text(errors="replace") if log.exists() else "")
        title_row = next((row for row in range(height) if "Session usage" in "".join(cell.ch for cell in parsed.rows[row])), None)
        assert title_row is not None, f"{label}: overlay title missing\n{parsed.lines()}"
        title_cells = parsed.rows[title_row]
        left = next((col for col, cell in enumerate(title_cells) if cell.ch == "│"), None)
        right = next((col for col in range(width - 1, -1, -1) if title_cells[col].ch == "│"), None)
        assert left is not None and right is not None and left < right, f"{label}: side borders missing\n{parsed.lines()}"
        top = title_row - 1
        bottom = next((row for row in range(title_row + 1, height) if parsed.rows[row][left].ch == "╰" and parsed.rows[row][right].ch == "╯"), None)
        assert top >= 0 and parsed.rows[top][left].ch == "╭" and parsed.rows[top][right].ch == "╮", f"{label}: top frame corners missing\n{parsed.lines()}"
        assert bottom is not None, f"{label}: bottom frame corners missing\n{parsed.lines()}"
        assert all(parsed.rows[row][left].ch == "│" and parsed.rows[row][right].ch == "│" for row in range(top + 1, bottom)), f"{label}: side borders are broken\n{parsed.lines()}"
        assert all(parsed.rows[top][col].ch == "─" and parsed.rows[bottom][col].ch == "─" for col in range(left + 1, right)), f"{label}: horizontal borders are broken\n{parsed.lines()}"

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

    try:
        wait(lambda text: "Pi" in text, "Pi startup")
        ui.send(master, "/cost-test\r")
        initial = wait(lambda text: "Session usage" in text, "cost overlay")
        assert "Current branch" in initial and "$0.001000" in initial, initial
        assert_overlay_frame("regular viewport")
        ui.send(master, "\r")
        expanded = wait(lambda text: "fake/healthy" in text, "Enter expands request model details")
        assert "Request 1*" in expanded and "fake/healthy" in expanded, expanded
        ui.send(master, "\t")
        models = wait(lambda text: "[Models]" in text, "Tab switches to models")
        assert "healthy" in models, models
        ui.send(master, "\x1b")
        wait(lambda text: "Session usage" not in text, "Esc closes overlay")

        width, height = 50, 14
        ui.set_winsize(master, height, width)
        os.kill(child.pid, signal.SIGWINCH)
        ui.send(master, "/cost-test\r")
        narrow = wait(lambda text: "Session usage" in text, "cost overlay at narrow usable viewport")
        assert_overlay_frame("narrow usable viewport")
        ui.send(master, "\x1b")
        wait(lambda text: "Session usage" not in text, "Esc closes narrow usable overlay")

        width, height = 24, 10
        ui.set_winsize(master, height, width)
        os.kill(child.pid, signal.SIGWINCH)
        ui.send(master, "/cost-test\r")
        narrow = wait(lambda text: "Resize terminal" in text, "narrow viewport guidance")
        assert all(len(line) <= width for line in narrow.splitlines()), narrow
        ui.send(master, "\x1b")
        wait(lambda text: "Resize terminal" not in text, "Esc closes narrow overlay")
        ui.assert_no_network_violations(home)
        print("PASS: real Pi cost overlay keyboard and narrow resize")
    finally:
        stop.set()
        group_alive = False
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                pass
            else:
                group_alive = True
        if master is not None:
            os.close(master)
        if reader is not None:
            reader.join(timeout=2)
        if group_alive:
            raise RuntimeError(f"Pi process group {child.pid} still exists; retaining fixture at {temp}")
        shutil.rmtree(temp)


if __name__ == "__main__":
    run()
