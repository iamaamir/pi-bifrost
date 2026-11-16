import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export type PanelTheme = Pick<ExtensionContext["ui"]["theme"], "fg">;

/** Frame full-width lines; callers can paint the whole frame with a background. */
export function renderPanel(lines: readonly string[], width: number, theme: PanelTheme, background: (text: string) => string = (text) => text): string[] {
  if (width < 4) return lines.map((line) => sliceByColumn(line, 0, Math.max(0, width), true));
  const contentWidth = width - 4;
  const border = (text: string) => theme.fg("border", text);
  const frame = (text: string) => background(text + " ".repeat(Math.max(0, width - visibleWidth(text))));
  return [
    frame(border(`╭${"─".repeat(width - 2)}╮`)),
    ...lines.map((line) => {
      const content = sliceByColumn(line, 0, contentWidth, true);
      return frame(`${border("│")} ${content}${" ".repeat(Math.max(0, contentWidth - visibleWidth(content)))} ${border("│")}`);
    }),
    frame(border(`╰${"─".repeat(width - 2)}╯`)),
  ];
}
