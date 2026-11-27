import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import type { InspectReport } from "./inspect-diagnostics.ts";
import { classifierRow, diagnosticsRow, warningRows } from "./inspect-diagnostics.ts";
import { jsonTreeRow } from "./json-tree.ts";
import { wrapApprovalLines } from "../config-approval.ts";
import { ExpandableRows } from "./expandable-rows.ts";
import { renderPanel } from "./panel.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg">;

function configurationRow(config: unknown) {
  const visibleConfig =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== "$schema"))
      : config;
  return jsonTreeRow("Full configuration", visibleConfig, "config");
}

export class InspectView {
  private readonly rows: ExpandableRows;
  private bodyHeight = 1;
  private readonly size: () => { columns: number; rows: number };
  private readonly theme: Theme;
  private readonly done: () => void;
  constructor(
    report: InspectReport,
    size: () => { columns: number; rows: number },
    theme: Theme,
    done: () => void,
    requestRender: () => void,
    config: unknown = {},
  ) {
    this.size = size;
    this.theme = theme;
    this.done = done;
    const rows = [
      ...warningRows(report),
      classifierRow(report),
      configurationRow(config),
      diagnosticsRow(report),
    ];
    this.rows = new ExpandableRows(
      rows,
      theme,
      () => ({ ...size(), rows: this.bodyHeight + 2 }),
      () => {},
      requestRender,
    );
  }
  invalidate(): void {
    this.rows.invalidate();
  }
  render(width: number): string[] {
    const contentWidth = Math.max(0, width - 4);
    const fit = (s: string) => sliceByColumn(s, 0, contentWidth, true);
    if (contentWidth < 20 || this.size().rows < 9)
      return renderPanel([fit("Resize terminal · Esc closes")], width, this.theme);
    const header = [
      "Bifrost inspect",
      "Loaded configuration · local snapshot",
      "────────────────────",
    ].flatMap((line) => wrapApprovalLines(line, contentWidth));
    const footer = wrapApprovalLines("↑↓ move · Enter expand · Esc close", contentWidth);
    this.bodyHeight = Math.floor(this.size().rows * 0.8) - header.length - footer.length - 4;
    if (this.bodyHeight < 1)
      return renderPanel([fit("Resize terminal · Esc closes")], width, this.theme);
    return renderPanel(
      [
        this.theme.fg("accent", header[0]!),
        ...header.slice(1),
        ...this.rows.render(contentWidth, false),
        ...footer.map((line) => this.theme.fg("muted", line)),
      ],
      width,
      this.theme,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done();
    else this.rows.handleInput(data);
  }
}

export async function showInspectView(
  ctx: ExtensionContext,
  report: InspectReport,
  config: unknown = {},
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) =>
      new InspectView(
        report,
        () => tui.terminal,
        theme,
        done,
        () => tui.requestRender(),
        config,
      ),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "top-center", margin: 1 },
    },
  );
  return true;
}
