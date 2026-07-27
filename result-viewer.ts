import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ResultTheme = Pick<ExtensionContext["ui"]["theme"], "fg">;

const MAX_VISIBLE_LINES = 10;

export function wrapResultLines(lines: readonly string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  const wrapped: string[] = [];

  for (const line of lines) {
    if (!line) {
      wrapped.push("");
      continue;
    }

    for (let offset = 0; offset < line.length; offset += safeWidth) {
      wrapped.push(line.slice(offset, offset + safeWidth));
    }
  }

  return wrapped;
}

class ResultViewer {
  private scrollOffset = 0;
  private maxOffset = 0;
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly theme: ResultTheme;
  private readonly done: () => void;
  private readonly requestRender: () => void;

  constructor(
    title: string,
    lines: readonly string[],
    theme: ResultTheme,
    done: () => void,
    requestRender: () => void,
  ) {
    this.title = title;
    this.lines = lines;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "\x03") {
      this.done();
      return;
    }

    if (data === "\x1b[A" || data === "k") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (data === "\x1b[B" || data === "j") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + 1);
    else if (data === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - MAX_VISIBLE_LINES);
    else if (data === "\x1b[6~") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + MAX_VISIBLE_LINES);
    else return;

    this.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const lines = wrapResultLines(this.lines, contentWidth);
    this.maxOffset = Math.max(0, lines.length - MAX_VISIBLE_LINES);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset);
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE_LINES);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string, color: "text" | "accent" | "dim" = "text") => {
      const padded = text.slice(0, contentWidth).padEnd(contentWidth);
      return `${border("│")} ${this.theme.fg(color, padded)} ${border("│")}`;
    };
    const title = this.title.slice(0, contentWidth);
    const scroll = lines.length > MAX_VISIBLE_LINES
      ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${lines.length} · ↑↓/jk scroll · esc close`
      : "esc close";

    return [
      border(`╭${"─".repeat(contentWidth + 2)}╮`),
      row(title, "accent"),
      row(scroll, "dim"),
      ...visible.map((line) => row(line)),
      ...Array.from({ length: MAX_VISIBLE_LINES - visible.length }, () => row("")),
      border(`╰${"─".repeat(contentWidth + 2)}╯`),
    ];
  }

  invalidate(): void {}
}

export async function showBifrostResult(
  ctx: ExtensionContext,
  title: string,
  lines: readonly string[],
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new ResultViewer(title, lines, theme, done, () => tui.requestRender()),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 40,
        maxHeight: "80%",
        anchor: "top-center",
        offsetY: 1,
        margin: 1,
      },
    },
  );
  return true;
}
