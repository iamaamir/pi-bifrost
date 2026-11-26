import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

/**
 * Dumb progress bar: renders measured or indeterminate progress.
 * Pure presentation — no widget, mode, or probe knowledge.
 */
export function progressBar(
  theme: { fg(color: string, text: string): string },
  options: ({ value: number; max: number } | { frame: number }) & { width?: number },
): Component {
  const width = options.width ?? 24;
  if ("frame" in options) {
    const position = ((options.frame % width) + width) % width;
    const bar = theme.fg("dim", "─".repeat(position)) + theme.fg("accent", "━") + theme.fg("dim", "─".repeat(width - position - 1));
    return new Text(`  ${bar}`, 0, 0);
  }
  const progress = options.max > 0 ? Math.min(1, options.value / options.max) : 0;
  const percent = Math.round(progress * 100);
  const filled = Math.round(progress * width);
  const bar = theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));

  return new Text(`  ${bar}  ${percent}%`, 0, 0);
}
