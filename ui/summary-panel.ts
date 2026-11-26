import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

/** Themed, wrapping summary for non-interactive widgets. */
export function summaryPanel(theme: Theme, lines: readonly string[]): Box {
  const box = new Box(2, 1, (text) => theme.bg("toolPendingBg", text));
  const styled = lines.map((line, index) => {
    if (index === 0) return theme.fg("accent", theme.bold(line));
    const match = /^(\S+(?:\s+\S+)?)(\s{2,})(.*)$/.exec(line);
    if (!match) return line;
    let value = match[3]!;
    if (match[1] === "Models") value = value.replace(/\b\d+ working models? found\b/, (count) => theme.fg("success", count));
    if (match[1] === "Also uses") value = value.replace(/\b(global|workspace)\b/g, (layer) => theme.fg("accent", layer));
    return theme.fg("muted", match[1]!) + match[2] + value;
  });
  box.addChild(new Text([styled[0], theme.fg("dim", "─────────────"), ...styled.slice(1)].join("\n"), 0, 0));
  return box;
}
