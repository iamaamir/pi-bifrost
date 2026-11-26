import type { Component } from "@earendil-works/pi-tui";
import { Box, Key, matchesKey, Text } from "@earendil-works/pi-tui";
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

export type ProbeProgress = ProbeProgressStats | { phase: "preparing" };

export function probeProgressComponent(
  theme: ProgressTheme,
  stats: ProbeProgress,
  cancellable = false,
  frame = 0,
): Component {
  if ("phase" in stats) {
    const box = new Box(0, 0, (text) => text);
    box.addChild(
      new Text(theme.bold("◆ Bifrost") + theme.fg("dim", "  Refreshing model catalog"), 0, 0),
    );
    box.addChild(
      new Text(
        `  ${theme.fg("dim", "─".repeat(frame % 20) + "━" + "─".repeat(19 - (frame % 20)))}`,
        0,
        0,
      ),
    );
    if (cancellable) box.addChild(new Text(theme.fg("dim", "  Esc to cancel"), 0, 0));
    return box;
  }
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
  if (cancellable) box.addChild(new Text(theme.fg("dim", "  Esc to cancel"), 0, 0));
  return box;
}

const activeAnimations = new WeakMap<ExtensionContext, () => void>();

export function clearProbeProgress(ctx: ExtensionContext): void {
  activeAnimations.get(ctx)?.();
  activeAnimations.delete(ctx);
  if (ctx.hasUI && typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("bifrost-probe", []);
}

/** Renders progress for UI hosts, using plain lines outside the TUI. */
export function setProbeProgress(
  ctx: ExtensionContext,
  stats: ProbeProgress,
  cancellable = false,
): void {
  if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
  activeAnimations.get(ctx)?.();
  activeAnimations.delete(ctx);
  if (ctx.mode === "tui") {
    let active = true;
    activeAnimations.set(ctx, () => {
      active = false;
    });
    ctx.ui.setWidget("bifrost-probe", (tui, theme) => {
      let frame = 0;
      const timer =
        active && "phase" in stats && tui
          ? setInterval(() => {
              frame++;
              tui.requestRender();
            }, 120)
          : undefined;
      timer?.unref();
      const dispose = () => {
        active = false;
        if (timer) clearInterval(timer);
      };
      if (active) activeAnimations.set(ctx, dispose);
      return {
        render: (width) => probeProgressComponent(theme, stats, cancellable, frame).render(width),
        invalidate() {},
        dispose,
      };
    });
  } else {
    ctx.ui.setWidget(
      "bifrost-probe",
      "phase" in stats
        ? ["Refreshing model catalog"]
        : [
            `Probing models: ${stats.done}/${stats.total}`,
            `  ok: ${stats.okCount}  errors: ${stats.errCount}`,
          ],
    );
  }
}

export async function withProgressCancellation<T>(
  ctx: ExtensionContext,
  run: (signal: AbortSignal | undefined, cancellable: boolean) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function")
    return run(ctx.signal, false);
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, Key.escape)) return undefined;
    controller.abort();
    return { consume: true };
  });
  try {
    return await run(signal, true);
  } finally {
    unsubscribe();
  }
}
