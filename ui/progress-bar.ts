import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

/**
 * Dumb progress bar: renders value/max as a filled bar with a percentage.
 * Pure presentation — no widget, mode, or probe knowledge.
 */
export function progressBar(
  theme: { fg(color: string, text: string): string },
  options: { value: number; max: number; width?: number },
): Component {
  const width = options.width ?? 24;
  const progress = options.max > 0 ? Math.min(1, options.value / options.max) : 0;
  const percent = Math.round(progress * 100);
  const filled = Math.round(progress * width);
  const bar = theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));

  return new Text(`  ${bar}  ${percent}%`, 0, 0);
}
