import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { progressBar } from "./progress-bar.ts";

/**
 * Container for the live probe progress widget, shared by /bifrost init and
 * /bifrost probe. Owns widget management and assembles the dumb components.
 */

export type ProbeProgressStats = {
  done: number;
  total: number;
  okCount: number;
  errCount: number;
};

type ProgressTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export function probeProgressComponent(theme: ProgressTheme, stats: ProbeProgressStats): Component {
  const header =
    theme.bold("◆ Bifrost") + theme.fg("dim", `  Probing models · ${stats.done}/${stats.total}`);
  const counts =
    theme.fg("success", `✓ ${stats.okCount} working`) +
    theme.fg("dim", "   ·   ") +
    theme.fg("error", `✗ ${stats.errCount} failed`);

  const box = new Box(0, 0, (text) => text);
  box.addChild(new Text(header, 0, 0));
  box.addChild(progressBar(theme, { value: stats.done, max: stats.total }));
  box.addChild(new Text(`  ${counts}`, 0, 0));
  return box;
}

/** Renders progress for UI hosts, using plain lines outside the TUI. */
export function setProbeProgress(ctx: ExtensionContext, stats: ProbeProgressStats): void {
  if (ctx.hasUI && ctx.mode === "tui") {
    ctx.ui.setWidget("bifrost-probe", (_tui, theme) => probeProgressComponent(theme, stats));
  } else if (ctx.hasUI) {
    ctx.ui.setWidget("bifrost-probe", [`Probing models: ${stats.done}/${stats.total}`, `  ok: ${stats.okCount}  errors: ${stats.errCount}`]);
  }
}
