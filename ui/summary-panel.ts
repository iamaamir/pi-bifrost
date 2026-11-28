import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Tones a summary panel may apply. `text` is the default; the other roles pair
 * color with a marker so the state survives limited-color themes.
 */
export type SummaryTone = "text" | "warning" | "error";

export type SummaryBlock =
  | { readonly kind: "row"; readonly label: string; readonly value: string }
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

/** Two columns of separation from docs/ui-design-system.md, aligned to the longest label. */
function labelGap(label: string, labelColumn: number): string {
  return " ".repeat(2 + labelColumn - visibleWidth(label));
}

type Row = Extract<SummaryBlock, { kind: "row" }>;
type Message = Extract<SummaryBlock, { kind: "message" }>;

type RowParts = { readonly label: string; readonly gap: string; readonly value: string };

/**
 * A row split into its parts. Plain and styled renderers differ only in the
 * theme roles they apply, so neither can drift from the other.
 */
function rowParts(block: Row, labelColumn: number): RowParts {
  return { label: block.label, gap: labelGap(block.label, labelColumn), value: block.value };
}

function messageParts(block: Message): { readonly marker: string; readonly text: string } {
  return { marker: marker(block.tone), text: block.text };
}

/**
 * Plain-text projection used for headless output and deterministic tests.
 * Carries the same facts as the rendered panel without terminal styling.
 */
export function summaryText(content: SummaryPanelContent): string[] {
  const labelColumn = labelWidth(content.blocks);
  return content.blocks.map((block) => {
    if (block.kind === "spacing") return "";
    if (block.kind === "message") {
      const { marker: prefix, text } = messageParts(block);
      return `${prefix}${text}`;
    }
    const { label, gap, value } = rowParts(block, labelColumn);
    return `${label}${gap}${value}`;
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
  const { marker: prefix, text } = messageParts(block);
  const indent = " ".repeat(prefix.length);
  // Severity rides on the marker and the sentence keeps the body color, so a
  // long repair instruction reads as text rather than as decoration. The marker
  // also spends width, so continuations must wrap inside the space it leaves.
  const [first = "", ...rest] = wrapTextWithAnsi(text, Math.max(1, width - prefix.length));
  const body = (part: string) => theme.fg("text", part);
  return [theme.fg(block.tone ?? "text", prefix) + body(first), ...rest.map((part) => indent + body(part))];
}

function rowLine(theme: SummaryTheme, block: SummaryBlock, labelColumn: number, width: number): string[] {
  if (block.kind !== "row") return [];
  const parts = rowParts(block, labelColumn);
  const value = theme.fg("text", parts.value);
  const line = theme.fg("muted", parts.label) + parts.gap + value;
  if (visibleWidth(line) <= width) return [line];
  // The design system puts the value on the next line when the row no longer
  // fits. Indent it under the value column only when that leaves room for the
  // whole value; a long path or identifier gets the full width instead of being
  // split mid-token by the indent.
  const hanging = labelColumn + 2;
  const indent = hanging <= width - 12 && visibleWidth(value) <= width - hanging ? hanging : 0;
  // A label can be wider than the body on its own; the box does not truncate,
  // so it wraps like every other line.
  const label = wrapTextWithAnsi(theme.fg("muted", parts.label), width);
  return [...label, ...wrapIndented(value, width, indent)];
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
    // The box pads the body and does not truncate, so an unwrapped title is the
    // one line that could still exceed the width it was given.
    const title = wrapTextWithAnsi(this.theme.fg("accent", this.theme.bold(this.content.title)), width);
    const rule = Math.min(width, Math.max(0, ...title.map(visibleWidth)));
    return [
      ...title,
      this.theme.fg("dim", "─".repeat(rule)),
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
