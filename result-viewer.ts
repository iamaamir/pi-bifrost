import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ResultTheme = Pick<ExtensionContext["ui"]["theme"], "fg">;


/** Match legacy Esc plus Kitty CSI-u and xterm modifyOtherKeys encodings. */
export function isEscapeKey(data: string): boolean {
  return data === "\x1b"
    || /^\x1b\[27(?:;1)?u$/.test(data)
    || data === "\x1b[27;1;27~";
}

export function wrapResultLines(lines: readonly string[], width: number): string[] {
  const limit = Math.max(2, width);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return lines.flatMap((line) => line.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, limit, segmenter)));
}

function wrapParagraph(paragraph: string, limit: number, segmenter: Intl.Segmenter): string[] {
  const wrapped: string[] = [];
  let part = "";
  for (const { segment } of segmenter.segment(paragraph)) {
    if (visibleWidth(part + segment) > limit) {
      const end = wrapBoundary(part);
      wrapped.push(part.slice(0, end));
      part = part.slice(end);
    }
    if (visibleWidth(part + segment) > limit) {
      wrapped.push(part);
      part = "";
    }
    part += segment;
  }
  return [...wrapped, part];
}

function wrapBoundary(part: string): number {
  const boundary = part.search(/\s+\S*$/u);
  if (boundary >= 0 && /\S/u.test(part.slice(boundary))) {
    return boundary + part.slice(boundary).match(/^\s+/u)![0].length;
  }
  return part.length;
}

function resultLayout(width: number, terminalRows: number) {
  // Match Pi overlay percentage rounding and one-row margins.
  const height = Math.max(1, Math.min(Math.floor(terminalRows * 0.8), terminalRows - 2));
  const framed = width >= 6 && height >= 5;
  const header = height >= (framed ? 5 : 3);
  const visibleLines = height - (framed ? 2 : 0) - (header ? 2 : 0);
  const contentWidth = framed ? width - 4 : Math.max(0, width);
  return { height, framed, header, visibleLines, contentWidth };
}

class ResultViewer {
  private scrollOffset = 0;
  private maxOffset = 0;
  private visibleLines = 1;
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly theme: ResultTheme;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private readonly terminalRows: () => number;

  constructor(
    title: string,
    lines: readonly string[],
    theme: ResultTheme,
    done: () => void,
    requestRender: () => void,
    terminalRows: () => number,
  ) {
    this.title = title;
    this.lines = lines;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.terminalRows = terminalRows;
  }

  handleInput(data: string): void {
    if (isEscapeKey(data) || data === "\x03") {
      this.done();
      return;
    }

    if (data === "\x1b[A" || data === "k") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (data === "\x1b[B" || data === "j") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + 1);
    else if (data === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - this.visibleLines);
    else if (data === "\x1b[6~") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + this.visibleLines);
    else return;

    this.requestRender();
  }

  render(width: number): string[] {
    const { height, framed, header, contentWidth, visibleLines } = resultLayout(width, this.terminalRows());
    this.visibleLines = visibleLines;
    if (contentWidth === 1) return Array.from("Resize wider", (character) => this.theme.fg("dim", character)).slice(0, height);
    const lines = wrapResultLines(this.lines, contentWidth);
    this.maxOffset = Math.max(0, lines.length - this.visibleLines);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset);
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + this.visibleLines);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string, color: "text" | "accent" | "dim" = "text") => {
      const clipped = truncateToWidth(text, contentWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      return framed ? `${border("│")} ${this.theme.fg(color, padded)} ${border("│")}` : this.theme.fg(color, padded);
    };
    const title = this.title;
    const scroll = lines.length > this.visibleLines
      ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${lines.length} · ↑↓/jk scroll · esc close`
      : "esc close";

    return [
      ...(framed ? [border(`╭${"─".repeat(contentWidth + 2)}╮`)] : []),
      ...(header ? [row(title, "accent"), row(scroll, "dim")] : []),
      ...visible.map((line) => row(line)),
      ...Array.from({ length: this.visibleLines - visible.length }, () => row("")),
      ...(framed ? [border(`╰${"─".repeat(contentWidth + 2)}╯`)] : []),
    ].map((line) => truncateToWidth(line, Math.max(0, width), ""));
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
    (tui, theme, _keybindings, done) => new ResultViewer(title, lines, theme, done, () => tui.requestRender(), () => tui.terminal.rows),
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
