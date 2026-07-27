#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pty
import fcntl
import termios
import struct
import signal
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "screenshots" / "ui-smoke"
PI = shutil.which("pi")

WIDTH = 120
HEIGHT = 36
TABSTOP = 8

ANSI_LOG = OUT / "pi-tui.log"


@dataclass
class Cell:
    ch: str = " "
    fg: tuple[int, int, int] = (208, 208, 208)
    bg: tuple[int, int, int] = (15, 15, 15)


class Screen:
    def __init__(self, width: int, height: int):
        self.width = width
        self.height = height
        self.rows: list[list[Cell]] = [[Cell() for _ in range(width)] for _ in range(height)]
        self.row = 0
        self.col = 0
        self.saved = (0, 0)
        self.saved_screen: list[list[Cell]] | None = None
        self.saved_fg = (208, 208, 208)
        self.saved_bg = (15, 15, 15)
        self.alt_screen = False
        self.fg = (208, 208, 208)
        self.bg = (15, 15, 15)

    def clear_all(self) -> None:
        self.rows = [[Cell() for _ in range(self.width)] for _ in range(self.height)]
        self.row = 0
        self.col = 0

    def save_screen(self) -> None:
        self.saved_screen = [[Cell(cell.ch, cell.fg, cell.bg) for cell in row] for row in self.rows]
        self.saved_fg = self.fg
        self.saved_bg = self.bg

    def restore_screen(self) -> None:
        if self.saved_screen is None:
            self.clear_all()
            self.fg = (208, 208, 208)
            self.bg = (15, 15, 15)
            self.alt_screen = False
            return
        self.rows = [[Cell(cell.ch, cell.fg, cell.bg) for cell in row] for row in self.saved_screen]
        self.fg = self.saved_fg
        self.bg = self.saved_bg
        self.alt_screen = False

    def clear_line(self, mode: int) -> None:
        if not (0 <= self.row < self.height):
            return
        if mode == 2:
            start, end = 0, self.width
        elif mode == 1:
            start, end = 0, min(self.width, self.col + 1)
        else:
            start, end = self.col, self.width
        for c in range(start, end):
            self.rows[self.row][c] = Cell()

    def scroll_up(self) -> None:
        self.rows.pop(0)
        self.rows.append([Cell() for _ in range(self.width)])
        self.row = self.height - 1

    def newline(self) -> None:
        self.col = 0
        self.row += 1
        if self.row >= self.height:
            self.scroll_up()

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.newline()
            return
        if ch == "\r":
            self.col = 0
            return
        if ch == "\b":
            self.col = max(0, self.col - 1)
            return
        if ch == "\t":
            self.col = min(self.width - 1, ((self.col // TABSTOP) + 1) * TABSTOP)
            return

        if not (0 <= self.row < self.height):
            return
        if self.col >= self.width:
            self.newline()
        if 0 <= self.row < self.height and 0 <= self.col < self.width:
            self.rows[self.row][self.col] = Cell(ch=ch, fg=self.fg, bg=self.bg)
        self.col += 1
        if self.col >= self.width:
            self.newline()

    def csi(self, final: str, params: str) -> None:
        cleaned = params.replace("?", "")
        raw = [p for p in cleaned.split(";") if p != ""] if cleaned else []
        ints = []
        for p in raw:
            try:
                ints.append(int(p))
            except ValueError:
                return

        if final in ("H", "f"):
            r = (ints[0] if len(ints) >= 1 else 1) - 1
            c = (ints[1] if len(ints) >= 2 else 1) - 1
            self.row = max(0, min(self.height - 1, r))
            self.col = max(0, min(self.width - 1, c))
            return

        if final == "G":
            c = (ints[0] if ints else 1) - 1
            self.col = max(0, min(self.width - 1, c))
            return

        if final == "A":
            self.row = max(0, self.row - (ints[0] if ints else 1))
            return
        if final == "B":
            self.row = min(self.height - 1, self.row + (ints[0] if ints else 1))
            return
        if final == "C":
            self.col = min(self.width - 1, self.col + (ints[0] if ints else 1))
            return
        if final == "D":
            self.col = max(0, self.col - (ints[0] if ints else 1))
            return

        if final == "J":
            mode = ints[0] if ints else 0
            if mode == 2:
                self.clear_all()
            elif mode == 0:
                for r in range(self.row, self.height):
                    start = self.col if r == self.row else 0
                    for c in range(start, self.width):
                        self.rows[r][c] = Cell()
            return

        if final == "K":
            self.clear_line(ints[0] if ints else 0)
            return

        if final == "s":
            self.saved = (self.row, self.col)
            return
        if final == "u":
            self.row, self.col = self.saved
            return

        if final == "m":
            self.apply_sgr(ints or [0])
            return

        if final in ("h", "l") and ints and ints[0] in (1047, 1048, 1049):
            if final == "h":
                self.save_screen()
                self.alt_screen = True
                self.clear_all()
                self.fg = (208, 208, 208)
                self.bg = (15, 15, 15)
            else:
                self.restore_screen()
            return

    def apply_sgr(self, codes: list[int]) -> None:
        i = 0
        while i < len(codes):
            code = codes[i]
            if code == 0:
                self.fg = (208, 208, 208)
                self.bg = (15, 15, 15)
            elif code == 39:
                self.fg = (208, 208, 208)
            elif code == 49:
                self.bg = (15, 15, 15)
            elif code in FG_8:
                self.fg = FG_8[code]
            elif code in BG_8:
                self.bg = BG_8[code]
            elif code == 38 and i + 4 < len(codes) and codes[i + 1] == 2:
                self.fg = (codes[i + 2], codes[i + 3], codes[i + 4])
                i += 4
            elif code == 48 and i + 4 < len(codes) and codes[i + 1] == 2:
                self.bg = (codes[i + 2], codes[i + 3], codes[i + 4])
                i += 4
            i += 1

    def parse(self, data: str) -> None:
        i = 0
        while i < len(data):
            ch = data[i]
            if ch != "\x1b":
                self.put(ch)
                i += 1
                continue

            if i + 1 >= len(data):
                break
            nxt = data[i + 1]
            if nxt == "[":
                j = i + 2
                while j < len(data):
                    c = data[j]
                    if "@" <= c <= "~":
                        self.csi(c, data[i + 2 : j])
                        j += 1
                        break
                    j += 1
                i = j
                continue
            if nxt == "]":
                j = i + 2
                while j < len(data):
                    if data[j] == "\a":
                        j += 1
                        break
                    if data[j] == "\x1b" and j + 1 < len(data) and data[j + 1] == "\\":
                        j += 2
                        break
                    j += 1
                i = j
                continue
            if nxt == "7":
                self.saved = (self.row, self.col)
                i += 2
                continue
            if nxt == "8":
                self.row, self.col = self.saved
                i += 2
                continue
            if nxt == "c":
                self.clear_all()
                self.fg = (208, 208, 208)
                self.bg = (15, 15, 15)
                i += 2
                continue
            i += 2

    def lines(self) -> list[str]:
        return ["".join(cell.ch for cell in row).rstrip() for row in self.rows]

    def draw(self, path: Path) -> None:
        font = load_font(18)
        cell_w = max(10, font.getbbox("M")[2] - font.getbbox("M")[0] + 1)
        cell_h = max(18, font.getbbox("Ag")[3] - font.getbbox("Ag")[1] + 4)
        margin = 12
        img = Image.new("RGB", (self.width * cell_w + margin * 2, self.height * cell_h + margin * 2), (8, 8, 8))
        draw = ImageDraw.Draw(img)

        for y, row in enumerate(self.rows):
            x = margin
            for cell in row:
                if cell.bg != (15, 15, 15):
                    draw.rectangle((x, margin + y * cell_h, x + cell_w, margin + (y + 1) * cell_h), fill=cell.bg)
                if cell.ch != " ":
                    draw.text((x, margin + y * cell_h), cell.ch, font=font, fill=cell.fg)
                x += cell_w

        img.save(path)


FG_8 = {
    30: (0, 0, 0),
    31: (220, 80, 80),
    32: (120, 200, 120),
    33: (220, 180, 80),
    34: (120, 160, 240),
    35: (200, 120, 220),
    36: (120, 220, 220),
    37: (210, 210, 210),
    90: (110, 110, 110),
    91: (255, 120, 120),
    92: (140, 240, 140),
    93: (255, 220, 120),
    94: (160, 200, 255),
    95: (240, 160, 255),
    96: (160, 255, 255),
    97: (255, 255, 255),
}
BG_8 = {
    40: (0, 0, 0),
    41: (120, 40, 40),
    42: (40, 120, 40),
    43: (120, 100, 40),
    44: (40, 60, 120),
    45: (120, 40, 120),
    46: (40, 120, 120),
    47: (180, 180, 180),
    100: (70, 70, 70),
    101: (160, 70, 70),
    102: (70, 160, 70),
    103: (160, 140, 70),
    104: (70, 90, 160),
    105: (160, 70, 160),
    106: (70, 160, 160),
    107: (220, 220, 220),
}


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Monaco.ttf",
        "/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    ]
    for item in candidates:
        if Path(item).exists():
            try:
                return ImageFont.truetype(item, size=size)
            except Exception:
                pass
    return ImageFont.load_default()


def set_winsize(fd: int, rows: int, cols: int) -> None:
    winsz = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)


def spawn_pi(log_path: Path, cwd: Path) -> tuple[subprocess.Popen[bytes], int]:
    if not PI:
        raise SystemExit("pi not found on PATH")

    master, slave = pty.openpty()
    set_winsize(master, HEIGHT, WIDTH)
    env = os.environ.copy()
    env.update(
        {
            "PI_TUI_WRITE_LOG": str(log_path),
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_OFFLINE": "1",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        }
    )
    proc = subprocess.Popen(
        [
            PI,
            "-e",
            str(ROOT),
            "--approve",
            "--no-session",
            "--no-tools",
            "--provider",
            "ollama",
            "--model",
            "gemma4:12b-mlx",
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=str(cwd),
        env=env,
        preexec_fn=os.setsid,
    )
    os.close(slave)
    return proc, master


def reader(master: int, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            data = os.read(master, 4096)
            if not data:
                break
        except OSError:
            break


def send(master: int, text: str) -> None:
    os.write(master, text.encode())


def wait_stable(path: Path, timeout: float = 8.0, stable_for: float = 0.6) -> None:
    last_size = -1
    last_change = time.time()
    start = time.time()
    while time.time() - start < timeout:
        size = path.stat().st_size if path.exists() else 0
        if size != last_size:
            last_size = size
            last_change = time.time()
        elif time.time() - last_change >= stable_for:
            return
        time.sleep(0.1)
    raise TimeoutError(f"log not stable: {path}")


def capture(name: str, enabled: bool, actions: Iterable[tuple[float, str]] = ()) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    log_path = OUT / f"{name}.ansi.log"
    png_path = OUT / f"{name}.png"
    txt_path = OUT / f"{name}.txt"
    if log_path.exists():
        log_path.unlink()

    tmp = tempfile.TemporaryDirectory()
    workspace = Path(tmp.name)
    config = json.loads((ROOT / "bifrost.json").read_text())
    config["enabled"] = enabled
    (workspace / "bifrost.json").write_text(json.dumps(config, indent=2) + "\n")

    proc, master = spawn_pi(log_path, workspace)
    stop = threading.Event()
    t = threading.Thread(target=reader, args=(master, stop), daemon=True)
    t.start()

    try:
        time.sleep(2.5)
        for delay, payload in actions:
            time.sleep(delay)
            send(master, payload)
            time.sleep(1.5)

        time.sleep(2.0)
        raw = log_path.read_text(errors="ignore") if log_path.exists() else ""
        screen = Screen(WIDTH, HEIGHT)
        screen.parse(raw)
        txt_path.write_text("\n".join(screen.lines()) + "\n")
        screen.draw(png_path)
        return png_path
    finally:
        stop.set()
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.close(master)
        except OSError:
            pass
        tmp.cleanup()


def main() -> int:
    captures = [
        ("startup", True, []),
        ("dashboard", True, [(1.0, "/bifrost\r")]),
        ("preview", True, [(0.5, "/bifrost classifier off\r"), (0.5, "/bifrost preview hello\r")]),
        ("preview-dismiss", True, [(0.5, "/bifrost classifier off\r"), (0.5, "/bifrost preview hello\r"), (0.5, "\x1b")]),
        ("disabled", False, []),
        ("classify", True, [(1.0, "hello\r")]),
        ("pinned", True, [(1.0, "\x10")]),
    ]
    results = []
    for name, enabled, actions in captures:
        print(f"[ui-smoke] capturing {name}…")
        results.append(capture(name, enabled, actions))
    print("[ui-smoke] done")
    for p in results:
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
