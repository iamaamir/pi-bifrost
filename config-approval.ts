import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Preserve every cell, including leading/trailing whitespace; never word-wrap values. */
export function wrapApprovalLines(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 2) throw new Error("Approval width must be at least two cells");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return text.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let part = "";
    let cells = 0;
    for (const { segment } of segmenter.segment(line)) {
      const segmentWidth = visibleWidth(segment);
      if (cells + segmentWidth > width) {
        if (!part) throw new Error("Approval text cannot fit the viewport");
        lines.push(part);
        part = "";
        cells = 0;
      }
      part += segment;
      cells += segmentWidth;
    }
    return [...lines, part];
  });
}

/** One instance owns one immutable proposal; only rendered, sequential pages count. */
export class ConfigApproval {
  private page = 0;
  private summaryPages: string[][] = [];
  private detailPages: string[][] = [];
  private view: "summary" | "details" = "summary";
  private geometry = "";
  private rendered = false;
  private usable = false;

  readonly title: string;
  readonly summary: string;
  readonly details: string;
  private readonly size: () => { columns: number; rows: number };
  private readonly done: (approved: boolean) => void;
  private readonly requestRender: () => void;

  constructor(
    title: string,
    summary: string,
    details: string,
    size: () => { columns: number; rows: number },
    done: (approved: boolean) => void,
    requestRender: () => void,
  ) {
    this.title = title;
    this.summary = summary;
    this.details = details;
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
      this.view = "summary";
      this.rendered = false;
      this.usable = columns >= 40 && width >= 39 && rows >= 8;
      this.summaryPages = [];
      this.detailPages = [];
      if (this.usable) {
        const capacity = rows - 4;
        const paginate = (text: string): string[][] => {
          const lines = wrapApprovalLines(text, width);
          const pages: string[][] = [];
          for (let i = 0; i < lines.length; i += capacity) pages.push(lines.slice(i, i + capacity));
          return pages;
        };
        this.summaryPages = paginate(`${this.title}\n${this.summary}`);
        this.detailPages = paginate(`${this.title}\n${this.details}`);
      }
    }
    if (!this.usable) return [sliceByColumn("Resize to 40x8; Esc cancels", 0, Math.max(0, width), true)];
    this.rendered = true;
    const pages = this.view === "summary" ? this.summaryPages : this.detailPages;
    const last = this.page === pages.length - 1;
    const footer = this.view === "summary"
      ? last ? "a Apply | d Details | Esc Cancel" : "n Next | d Details | Esc"
      : last ? "a Apply | p Prev | b Summary | Esc" : "n Next | p Prev | b Summary | Esc";
    return [
      this.view === "summary" ? `Bifrost summary ${this.page + 1}/${pages.length}` : `Full exact change ${this.page + 1}/${pages.length}`,
      ...pages[this.page]!,
      "",
      footer,
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(false);
      return;
    }
    const { columns, rows } = this.size();
    if (!this.geometry.endsWith(`/${columns}/${rows}`) || !this.usable || !this.rendered) return;
    const pages = this.view === "summary" ? this.summaryPages : this.detailPages;
    if (data === "a" && this.page === pages.length - 1) {
      this.done(true);
      return;
    }
    if (this.view === "summary" && data === "d") {
      this.view = "details";
      this.page = 0;
    } else if (this.view === "details" && data === "b") {
      this.view = "summary";
      this.page = 0;
    } else if (data === "n" && this.page < pages.length - 1) this.page += 1;
    else if (this.view === "details" && data === "p" && this.page > 0) this.page -= 1;
    else return;
    this.rendered = false;
    this.requestRender();
  }
}

export async function approveConfig(
  ctx: ExtensionContext,
  title: string,
  summary: string,
  details: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted) return false;
  let cancel: (() => void) | undefined;
  let resize: (() => void) | undefined;
  try {
    const approved = await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
      cancel = () => done(false);
      signal?.addEventListener("abort", cancel, { once: true });
      const viewer = new ConfigApproval(title, summary, details, () => tui.terminal, done, () => tui.requestRender());
      resize = () => viewer.invalidate();
      process.stdout.on("resize", resize);
      if (signal?.aborted) cancel();
      return viewer;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: { right: 1, bottom: 1 } } });
    return approved === true && !signal?.aborted;
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
    if (resize) process.stdout.off("resize", resize);
  }
}
