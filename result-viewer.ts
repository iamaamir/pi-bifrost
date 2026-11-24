import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ResultTheme = Pick<ExtensionContext["ui"]["theme"], "fg">;

const MAX_VISIBLE_LINES = 10;
/** Match legacy Esc plus Kitty CSI-u and xterm modifyOtherKeys encodings. */
export function isEscapeKey(data: string): boolean {
  return data === "\x1b"
    || /^\x1b\[27(?:;1)?u$/.test(data)
    || data === "\x1b[27;1;27~";
}

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

export class ResultViewer {
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
    if (isEscapeKey(data) || data === "\x03") {
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

export class InitReview {
  private selected = 0;
  private scrollOffset = 0;
  private maxOffset = 0;
  private expanded = false;
  private canConfirm = false;
  private readonly summary: readonly string[];
  private readonly details: readonly string[];
  private readonly actions: readonly string[];
  private readonly theme: ResultTheme;
  private readonly done: (result: string) => void;
  private readonly requestRender: () => void;

  constructor(
    summary: readonly string[],
    details: readonly string[],
    actions: readonly string[],
    theme: ResultTheme,
    done: (result: string) => void,
    requestRender: () => void,
  ) {
    this.summary = summary;
    this.details = details;
    this.actions = actions;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
  }

  handleInput(data: string): void {
    if (isEscapeKey(data) || data === "\x03") {
      this.done("");
      return;
    }
    if (data === "\x0f") this.expanded = !this.expanded;
    else if (data === "\r" || data === "\n") {
      if (this.canConfirm && this.actions.length > 0) this.done(this.actions[this.selected]);
    }
    else if (!this.selectOrScroll(data)) return;
    this.requestRender();
  }

  private selectOrScroll(data: string): boolean {
    if (data === "\x1b[A") this.selected = (this.selected + this.actions.length - 1) % this.actions.length;
    else if (data === "\x1b[B") this.selected = (this.selected + 1) % this.actions.length;
    else if (data === "k" || data === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (data === "j" || data === "\x1b[6~") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + 1);
    else return false;
    return true;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const source = this.expanded ? this.details : this.summary;
    const content = wrapResultLines(source, contentWidth);
    this.maxOffset = Math.max(0, content.length - 4);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset);
    const visible = content.slice(this.scrollOffset, this.scrollOffset + 4);
    const row = (text: string, color: "text" | "accent" | "dim" = "text") => this.theme.fg(color, text.slice(0, contentWidth));
    const actionRows = this.actions.flatMap((action, index) => {
      const labelWidth = contentWidth - 2;
      const labelLines = wrapResultLines([action], Math.max(1, labelWidth));
      return labelLines.map((line, lineIndex) => row(`${lineIndex === 0 && index === this.selected ? "❯ " : "  "}${line}`, "accent"));
    });
    this.canConfirm = contentWidth >= 3 && this.actions.length > 0;
    return [
      row("Bifrost · Review setup", "accent"),
      row(this.expanded ? "Ctrl+O summary · PgUp/PgDn or jk scroll" : "Ctrl+O full details · PgUp/PgDn or jk scroll", "dim"),
      ...visible.map((line) => row(line)),
      row(""),
      ...actionRows,
      row("↑↓ select · enter confirm · esc cancel", "dim"),
    ];
  }

  invalidate(): void {}
}

export async function showInitReview(
  ctx: ExtensionContext,
  summary: readonly string[],
  details: readonly string[],
  actions: readonly string[],
): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  const result = await ctx.ui.custom<string>(
    (tui, theme, _keybindings, done) => new InitReview(summary, details, actions, theme, done, () => tui.requestRender()),
  );
  if (result === undefined) throw new Error("custom review UI returned no result");
  return result;
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
