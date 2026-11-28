import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Tones a summary panel may apply. `text` is the default; the other roles pair
 * color with a marker so the state survives limited-color themes.
 */
export type SummaryTone = "text" | "warning" | "error";

export type SummaryBlock =
  | { readonly kind: "row"; readonly label: string; readonly value: string; readonly tone?: SummaryTone }
  | { readonly kind: "message"; readonly text: string; readonly tone?: SummaryTone }
  | { readonly kind: "spacing" };

/** A short, passive result: title, aligned rows, and optional messages. */
export interface SummaryPanelContent {
  readonly title: string;
  readonly blocks: readonly SummaryBlock[];
}

export type SummaryTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bg" | "bold">;

const MARKERS: Record<Exclude<SummaryTone, "text">, string> = {
  warning: "! ",
  error: "✗ ",
};

function marker(tone: SummaryTone | undefined): string {
  return tone === "warning" || tone === "error" ? MARKERS[tone] : "";
}

function labelWidth(blocks: readonly SummaryBlock[]): number {
  return Math.max(0, ...blocks.flatMap((block) => (block.kind === "row" ? [visibleWidth(block.label)] : [])));
}

/**
 * Plain-text projection used for headless output and deterministic tests.
 * Carries the same facts as the rendered panel without terminal styling.
 */
export function summaryText(content: SummaryPanelContent): string[] {
  const width = labelWidth(content.blocks);
  return content.blocks.map((block) => {
    if (block.kind === "spacing") return "";
    if (block.kind === "message") return `${marker(block.tone)}${block.text}`;
    const gap = " ".repeat(2 + width - visibleWidth(block.label));
    return `${block.label}${gap}${marker(block.tone)}${block.value}`;
  });
}

/**
 * A wrapped line keeps its continuation indented under the value column, so a
 * long value cannot read as the next row's label.
 */
function wrapIndented(line: string, width: number, indent: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const available = Math.max(1, width - indent);
  return wrapTextWithAnsi(line, available).map((part, index) =>
    index === 0 || indent === 0 ? part : " ".repeat(indent) + part,
  );
}

function messageLine(theme: SummaryTheme, block: SummaryBlock, width: number): string[] {
  if (block.kind !== "message") return [];
  const prefix = marker(block.tone);
  // Severity rides on the marker and the sentence keeps the body color, so a
  // long repair instruction reads as text rather than as decoration.
  const [first = "", ...rest] = wrapTextWithAnsi(`${prefix}${block.text}`, width);
  const body = (part: string) => theme.fg("text", part);
  return [
    theme.fg(block.tone ?? "text", first.slice(0, prefix.length)) + body(first.slice(prefix.length)),
    ...rest.map((part) => " ".repeat(prefix.length) + body(part)),
  ];
}

function rowLine(theme: SummaryTheme, block: SummaryBlock, labelColumn: number, width: number): string[] {
  if (block.kind !== "row") return [];
  const gap = " ".repeat(2 + labelColumn - visibleWidth(block.label));
  const value = theme.fg(block.tone ?? "text", `${marker(block.tone)}${block.value}`);
  const line = theme.fg("muted", block.label) + gap + value;
  if (visibleWidth(line) <= width) return [line];
  // The design system puts the value on the next line when the row no longer
  // fits. Indent it under the value column only when that leaves room for the
  // whole value; a long path or identifier gets the full width instead of being
  // split mid-token by the indent.
  const hanging = labelColumn + 2;
  const indent = hanging <= width - 12 && visibleWidth(value) <= width - hanging ? hanging : 0;
  return [theme.fg("muted", block.label), ...wrapIndented(value, width, indent)];
}

function renderBlock(theme: SummaryTheme, block: SummaryBlock, labelColumn: number, width: number): string[] {
  if (block.kind === "spacing") return [""];
  return block.kind === "message"
    ? messageLine(theme, block, width)
    : rowLine(theme, block, labelColumn, width);
}

class SummaryBody {
  private readonly theme: SummaryTheme;
  private readonly content: SummaryPanelContent;
  constructor(theme: SummaryTheme, content: SummaryPanelContent) {
    this.theme = theme;
    this.content = content;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const labelColumn = labelWidth(this.content.blocks);
    const title = this.theme.fg("accent", this.theme.bold(this.content.title));
    return [
      title,
      this.theme.fg("dim", "─".repeat(Math.min(visibleWidth(title), width))),
      ...this.content.blocks.flatMap((block) => renderBlock(this.theme, block, labelColumn, width)),
    ];
  }
}

/** Render a summary panel: theme background, accent title, aligned label/value rows. */
export function summaryPanel(theme: SummaryTheme, content: SummaryPanelContent): Box {
  const box = new Box(2, 1, (text) => theme.bg("toolPendingBg", text));
  box.addChild(new SummaryBody(theme, content));
  return box;
}
