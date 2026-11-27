import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ExpandableRow {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly warning?: boolean;
  readonly children?: readonly ExpandableRow[];
}

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

/** Keyboard tree/list view intended to be embedded in a Pi TUI overlay. */
export class ExpandableRows {
  private readonly rows: readonly ExpandableRow[];
  private readonly theme: Theme;
  private readonly size: () => { columns: number; rows: number };
  private readonly onSelect: (row: ExpandableRow) => void;
  private readonly requestRender: () => void;
  private readonly expanded = new Set<string>();
  private visible: { row: ExpandableRow; depth: number }[] = [];
  private selected = 0;
  private selectedPart = 0;
  private wrappedLineCounts: number[] = [];
  private wrappedLines: { rowIndex: number; part: number; prefix: string; text: string }[] = [];
  private rowStarts: number[] = [];
  private offset = 0;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(
    rows: readonly ExpandableRow[],
    theme: Theme,
    size: () => { columns: number; rows: number },
    onSelect: (row: ExpandableRow) => void,
    requestRender: () => void,
  ) {
    this.rows = rows;
    this.theme = theme;
    this.size = size;
    this.onSelect = onSelect;
    this.requestRender = requestRender;
    this.refreshVisible();
  }

  invalidate(): void {
    this.lastWidth = 0;
    this.lastHeight = 0;
  }

  render(width: number, pad = true): string[] {
    const { rows } = this.size();
    const height = Math.max(1, rows - 2);
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.wrappedLines = [];
      this.lastWidth = width;
      this.lastHeight = height;
      this.offset = Math.min(this.offset, Math.max(0, this.visible.length - height));
    }
    if (!this.wrappedLines.length) this.wrappedLines = this.visible.flatMap(({ row, depth }, index) => {
      this.rowStarts[index] = index ? this.rowStarts[index - 1]! + this.wrappedLineCounts[index - 1]! : 0;
      const marker = row.children?.length ? (this.expanded.has(row.id) ? "▾ " : "▸ ") : "  ";
      const indent = Math.min(depth, Math.floor(Math.max(0, width - 14) / 2));
      const prefix = `${"  ".repeat(indent)}${marker}`;
      const text = `${row.label}${row.detail ? `  ${row.detail}` : ""}`;
      const available = Math.max(1, width - visibleWidth(prefix) - 2);
      const wrapped = wrapCells(text, available);
      this.wrappedLineCounts[index] = wrapped.length;
      return wrapped.map((part, line) => {
        return { rowIndex: index, part: line, prefix: line === 0 ? prefix : "  ", text: part };
      });
    });
    const lines = this.wrappedLines;
    this.selectedPart = Math.min(this.selectedPart, (this.wrappedLineCounts[this.selected] ?? 1) - 1);
    const maxOffset = Math.max(0, lines.length - height);
    this.offset = Math.min(this.offset, maxOffset);
    const selectedLine = (this.rowStarts[this.selected] ?? 0) + this.selectedPart;
    if (selectedLine < this.offset) this.offset = selectedLine;
    else if (selectedLine >= this.offset + height) this.offset = selectedLine - height + 1;
    const selectedCount = this.wrappedLineCounts[this.selected] ?? 0;
    if (selectedCount <= height) {
      const start = selectedLine - this.selectedPart;
      const end = start + selectedCount;
      if (start < this.offset) this.offset = start;
      else if (end > this.offset + height) this.offset = end - height;
    }
    const visible = lines.slice(this.offset, this.offset + height).map((line) => {
      const selected = line.rowIndex === this.selected;
      const marker = line.part === 0 && selected ? "› " : "  ";
      return this.theme.fg(selected ? "accent" : this.visible[line.rowIndex]?.row.warning ? "warning" : "text", `${marker}${line.prefix}${line.text}`);
    });
    return pad ? [...visible, ...Array.from({ length: Math.max(0, height - visible.length) }, () => "")] : visible;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") this.move(-1);
    else if (matchesKey(data, "down") || data === "j") this.move(1);
    else if (data === "\x1b[5~") this.moveRow(-Math.max(1, this.lastHeight - 1));
    else if (data === "\x1b[6~") this.moveRow(Math.max(1, this.lastHeight - 1));
    else if (matchesKey(data, "left") || data === "h") this.collapse();
    else if (matchesKey(data, "right") || data === "l") this.expand();
    else if (matchesKey(data, "enter")) {
      const row = this.visible[this.selected]?.row;
      if (row?.children?.length) {
        if (this.expanded.has(row.id)) this.expanded.delete(row.id);
        else this.expanded.add(row.id);
        this.refreshVisible();
        this.selectedPart = 0;
        this.requestRender();
      } else if (row) this.onSelect(row);
      return;
    } else return;
    this.requestRender();
  }

  private move(by: number): void {
    const lineCount = this.wrappedLineCounts[this.selected] ?? 1;
    if (lineCount > Math.max(1, this.lastHeight) && by > 0 && this.selectedPart + 1 < lineCount) this.selectedPart++;
    else if (lineCount > Math.max(1, this.lastHeight) && by < 0 && this.selectedPart > 0) this.selectedPart--;
    else this.moveRow(by);
  }

  private moveRow(by: number): void {
    const selected = Math.max(0, Math.min(this.visible.length - 1, this.selected + by));
    if (selected !== this.selected) {
      this.selected = selected;
      this.selectedPart = by < 0 ? (this.wrappedLineCounts[this.selected] ?? 1) - 1 : 0;
    }
  }

  private expand(): void {
    const row = this.visible[this.selected]?.row;
    if (row?.children?.length && !this.expanded.has(row.id)) {
      this.expanded.add(row.id);
      this.refreshVisible();
      this.selectedPart = 0;
    }
  }

  private collapse(): void {
    const item = this.visible[this.selected];
    if (!item) return;
    if (this.expanded.delete(item.row.id)) {
      this.refreshVisible();
      this.selectedPart = 0;
    }
    else if (item.depth > 0) {
      const parent = this.visible.slice(0, this.selected).reverse().find((candidate) => candidate.depth === item.depth - 1);
      if (parent) this.selected = this.visible.indexOf(parent);
    }
  }

  private refreshVisible(): void {
    const result: { row: ExpandableRow; depth: number }[] = [];
    const visit = (items: readonly ExpandableRow[], depth: number) => {
      for (const row of items) {
        result.push({ row, depth });
        if (this.expanded.has(row.id) && row.children) visit(row.children, depth + 1);
      }
    };
    visit(this.rows, 0);
    this.visible = result;
    this.wrappedLines = [];
    this.selected = Math.max(0, Math.min(this.selected, result.length - 1));
    this.wrappedLineCounts.length = result.length;
    this.selectedPart = Math.min(this.selectedPart, (this.wrappedLineCounts[this.selected] ?? 1) - 1);
    this.offset = Math.min(this.offset, Math.max(0, result.length - Math.max(1, this.lastHeight)));
  }

}

function wrapCells(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width);
}
