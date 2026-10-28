import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Preserve every cell, including leading/trailing whitespace; never word-wrap values. */
export function wrapApprovalLines(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 2) throw new Error("Approval width must be at least two cells");
  return text.split("\n").flatMap((line) => {
    const lines: string[] = [];
    while (visibleWidth(line) > width) {
      const part = sliceByColumn(line, 0, width, true);
      if (!part) throw new Error("Approval text cannot fit the viewport");
      lines.push(part);
      line = line.slice(part.length);
    }
    return [...lines, line];
  });
}

/** One instance owns one immutable proposal; only rendered, sequential pages count. */
export class ConfigApproval {
  private page = 0;
  private pages: string[][] = [];
  private geometry = "";
  private rendered = false;
  private usable = false;

  readonly title: string;
  readonly message: string;
  private readonly size: () => { columns: number; rows: number };
  private readonly done: (approved: boolean) => void;
  private readonly requestRender: () => void;

  constructor(
    title: string,
    message: string,
    size: () => { columns: number; rows: number },
    done: (approved: boolean) => void,
    requestRender: () => void,
  ) {
    this.title = title;
    this.message = message;
    this.size = size;
    this.done = done;
    this.requestRender = requestRender;
  }

  invalidate(): void {
    this.geometry = "";
    this.rendered = false;
  }

  render(width: number): string[] {
    const { columns, rows } = this.size();
    const geometry = `${width}/${columns}/${rows}`;
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      this.page = 0;
      this.rendered = false;
      this.usable = columns >= 40 && width >= 39 && rows >= 8;
      this.pages = [];
      if (this.usable) {
        const lines = wrapApprovalLines(`${this.title}\n${this.message}`, width);
        const capacity = rows - 4;
        for (let i = 0; i < lines.length; i += capacity) this.pages.push(lines.slice(i, i + capacity));
      }
    }
    if (!this.usable) return [sliceByColumn("Resize to 40x8; Esc cancels", 0, Math.max(0, width), true)];
    this.rendered = true;
    const last = this.page === this.pages.length - 1;
    return [
      `Bifrost review ${this.page + 1}/${this.pages.length}`,
      ...this.pages[this.page]!,
      "",
      last ? "a Apply | p Previous | Esc Cancel" : "n Next | p Previous | Esc Cancel",
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(false);
      return;
    }
    const { columns, rows } = this.size();
    if (!this.geometry.endsWith(`/${columns}/${rows}`) || !this.usable || !this.rendered) return;
    if (data === "a" && this.page === this.pages.length - 1) {
      this.done(true);
      return;
    }
    if (data === "n" && this.page < this.pages.length - 1) this.page += 1;
    else if (data === "p" && this.page > 0) this.page -= 1;
    else return;
    this.rendered = false;
    this.requestRender();
  }
}

export async function approveConfig(
  ctx: ExtensionContext,
  title: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted) return false;
  let cancel: (() => void) | undefined;
  try {
    const approved = await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
      cancel = () => done(false);
      signal?.addEventListener("abort", cancel, { once: true });
      const viewer = new ConfigApproval(title, message, () => tui.terminal, done, () => tui.requestRender());
      if (signal?.aborted) cancel();
      return viewer;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: { right: 1, bottom: 1 } } });
    return approved === true && !signal?.aborted;
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
