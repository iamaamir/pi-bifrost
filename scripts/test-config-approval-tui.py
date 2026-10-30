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
        original_config = {"schemaVersion": 2, "enabled": False, "default": "general", "models": {"general": ["fake/healthy"]}, "classifier": {"enabled": True}, "rules": [{"pattern": f"rule-{index}", "model": "general"} for index in range(15)] + [{"pattern": "review", "model": "general"}]}
        original = json.dumps(original_config)
        source = work / ".pi/bifrost.json"
        workspace_source = work / "bifrost.json"
        source.write_text(original)
        workspace_source.write_text(original)
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
            found = re.search(r"(?:Bifrost summary|Full exact change) (\d+)/(\d+)", text)
            return (int(found[1]), int(found[2])) if found else (0, 0)

        def compact_summary(text):
            return re.sub(r"[\s─.]", "", text)

        def traverse(label):
            seen = []
            for _ in range(100):
                text = wait(lambda s: page(s)[0] > 0, f"{label} page")
                current, total = page(text)
                seen.append(text)
                unchanged()
                if current == total:
                    assert "a Apply" in text, text
                    return "\n".join(seen)
                ui.send(master, "n")
                wait(lambda s, expected=(current + 1, total): page(s) == expected, "next rendered page")
            raise AssertionError(f"{label} review did not end")

        def start_case(argument=""):
            command = f"/approval-case {argument}".rstrip()
            ui.send(master, command)
            wait(lambda s: command in s, "command in editor")
            ui.send(master, "\r")

        try:
            wait(lambda s: "Bifrost" in s and "healthy" in s, "Pi startup")
            start_case()
            wait(lambda s: "Apply this Bifrost configuration?" in s, "approval surface")
            ui.send(master, "\r")
            time.sleep(0.2)
            unchanged()
            initial = wait(lambda s: page(s)[0] > 0, "summary")
            assert page(initial)[0] == 1 and 1 < page(initial)[1] <= 3, initial
            assert "TOOL-GENERATED SUMMARY" in initial, initial
            assert "HIDDEN_LAST_CHANGE" not in initial, initial
            summary = traverse("summary")
            summary_text = compact_summary(summary)
            assert "Classifierenabled:ON→OFF" in summary_text and "classificationdisabled" in summary_text, f"summary omits classifier status: {summary}"
            assert "ALLtarget-sourcerulesremoved" in summary_text and "16removed,0added" in summary_text, summary
            assert "tierPolicies" in summary_text, f"summary hides a changed field name: {summary}"
            assert "Modelpools" in summary_text and "review" in summary_text and "→1" in summary_text, summary
            assert "Fallbacks" in summary_text and "general" in summary_text, summary
            assert '"pattern"' not in summary_text and '"model"' not in summary_text and "fake/healthy" not in summary_text, summary
            ui.send(master, "d")
            wait(lambda s: "Full exact change 1/" in s, "exact review")
            ui.send(master, "a")
            time.sleep(0.2)
            unchanged()
            seen = traverse("exact")
            exact = seen
            assert "description" in exact, seen
            value = "".join(re.findall(r"x{2,}|HIDDEN_LAST_CHANGE", exact))
            assert value == "x" * 6_000 + "HIDDEN_LAST_CHANGE", f"captured exact value has {value.count('x')} x chars and suffix={value.endswith('HIDDEN_LAST_CHANGE')}"
            ui.send(master, "\x1b")
            wait(lambda _: result.exists(), "cancel result")
            assert json.loads(result.read_text())["status"] == "declined"
            assert source.read_text() == original
            result.unlink()
            start_case()
            wait(lambda s: page(s)[0] == 1, "second summary")
            ui.send(master, "d")
            wait(lambda s: "Full exact change 1/" in s, "second exact review")
            traverse("exact")
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
            wait(lambda s: "Bifrost summary 1/" in s, "resize resets to summary")
            ui.send(master, "d")
            wait(lambda s: "Full exact change 1/" in s, "exact view after resize")
            seen = traverse("exact")
            exact = seen
            value = "".join(re.findall(r"x{2,}|HIDDEN_LAST_CHANGE", exact))
            assert value == "x" * 6_000 + "HIDDEN_LAST_CHANGE", "full changed value must be inspectable"
            ui.send(master, "a")
            wait(lambda _: result.exists(), "apply result")
            assert json.loads(result.read_text())["status"] == "ok"
            saved = json.loads(source.read_text())
            expected = json.loads(original)
            expected["description"] = "x" * 6_000 + "HIDDEN_LAST_CHANGE"
            expected.update({
                "schemaVersion": 2,
                "classifier": {"enabled": False},
                "models": {"general": ["fake/healthy"], "review": ["fake/healthy"]},
                "rules": [],
                "tierPolicies": {"general": {"fallbackTiers": []}},
            })
            assert saved == expected
            result.unlink()
            source.write_text(original)
            width, height = 40, 9
            ui.set_winsize(master, height, width)
            os.kill(child.pid, signal.SIGWINCH)
            start_case()
            initial = wait(lambda s: page(s)[0] == 1, "narrow summary approval path")
            assert page(initial)[1] <= 4, initial
            assert "n Next | d Details" in initial, initial
            assert all(len(line) <= width for line in initial.splitlines()), initial
            summary = traverse("summary")
            summary_text = compact_summary(summary)
            assert "ON→OFF" in summary_text and "ALLtarget-sourcerulesremoved" in summary_text, summary
            assert "tierPolicies" in summary_text, f"narrow summary hides a changed field name: {summary}"
            assert '"pattern"' not in summary_text and '"model"' not in summary_text, summary
            ui.send(master, "a")
            wait(lambda _: result.exists(), "summary Apply result")
            assert json.loads(result.read_text())["status"] == "ok"
            assert json.loads(source.read_text()) == expected
            result.unlink()
            source.write_text(original)
            workspace_source.write_text(original)
            start_case("layered")
            initial = wait(lambda s: page(s)[0] == 1, "layered summary")
            assert page(initial)[1] <= 4, initial
            summary = traverse("layered summary")
            summary_text = compact_summary(summary)
            assert "Target-sourceclassifier" in summary_text and "ON→OFF" in summary_text, summary
            assert "EffectiveclassifierremainsON" in summary_text, summary
            assert "ALLtarget-sourcerulesremoved" in summary_text and "Effectiverulesunchanged" in summary_text, summary
            assert '"pattern"' not in summary_text and '"model"' not in summary_text, summary
            ui.send(master, "\x1b")
            wait(lambda _: result.exists(), "layered summary cancel")
            assert json.loads(result.read_text())["status"] == "declined"
            assert source.read_text() == original and workspace_source.read_text() == original
            result.unlink()

            enable_config = {**original_config, "classifier": {"enabled": False}}
            original = json.dumps(enable_config)
            source.write_text(original)
            workspace_source.write_text(original)
            start_case("classifier-on")
            summary = traverse("classifier enable summary")
            summary_text = compact_summary(summary)
            assert "OFF→ONinsourceandeffectivepolicy" in summary_text, summary
            assert "classificationenabled" in summary_text and "classificationdisabled" not in summary_text, summary
            ui.send(master, "\x1b")
            wait(lambda _: result.exists(), "classifier enable cancel")
            assert json.loads(result.read_text())["status"] == "declined"
            assert source.read_text() == original
            result.unlink()

            order_config = {
                "schemaVersion": 2,
                "enabled": False,
                "default": "general",
                "models": {"general": ["fake/healthy"], "review": ["fake/healthy"]},
                "classifier": {"enabled": False},
                "rules": [
                    {"pattern": "review", "model": "general"},
                    {"pattern": "review", "model": "review"},
                ],
            }
            original = json.dumps(order_config)
            source.write_text(original)
            workspace_source.write_text(original)
            start_case("rules-reorder")
            summary = traverse("rule order summary")
            summary_text = compact_summary(summary)
            assert "0removed,0added" in summary_text, summary
            assert "first-matchpriorityorderchanged" in summary_text and "inspectDetails" in summary_text, summary
            assert '"pattern"' not in summary_text and '"model"' not in summary_text, summary
            ui.send(master, "\x1b")
            wait(lambda _: result.exists(), "rule order cancel")
            assert json.loads(result.read_text())["status"] == "declined"
            assert source.read_text() == original
            ui.assert_no_network_violations(home)
            print("PASS: pinned Pi concise summary, source/effective layering, narrow viewport, exact review, fail-closed controls")
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
