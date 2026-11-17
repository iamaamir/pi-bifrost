import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Text, Box, mixColors } from "@earendil-works/pi-tui";

type NoticeLevel = "info" | "success" | "warning" | "error";

type BifrostNotice = {
  title: string;
  message: string;
  level: NoticeLevel;
  /** Optional indented detail lines rendered dimmer than the message. */
  details?: string[];
};

let entryApi: ExtensionAPI | undefined;

export function registerBifrostNotices(pi: ExtensionAPI) {
  if (typeof pi.registerEntryRenderer !== "function" || typeof pi.appendEntry !== "function") return;
  entryApi = pi;

  pi.registerEntryRenderer("bifrost-notice", (entry, _options, theme) => {
    const data = entry.data as BifrostNotice;

    const styles = {
      info: { icon: "○", color: "muted" },
      success: { icon: "✓", color: "success" },
      warning: { icon: "!", color: "warning" },
      error: { icon: "✗", color: "error" },
    } as const;

    const style = styles[data.level];
    const base = theme.colors.toolPendingBg;

    const intensity = {
      info: 0,
      success: 0.1,
      warning: 0.1,
      error: 0.18,
    } as const;

    const bg = mixColors(base, theme.colors[style.color], intensity[data.level]);

    const box = new Box(1, 0.2, (text) => theme.style(text, { bg }));

    const lines = [
      theme.fg("dim", "bifrost") +
        " " +
        theme.fg(style.color, style.icon) +
        " " +
        theme.fg(style.color, theme.bold(data.title)),
    ];

    if (data.message?.trim()) {
      lines.push(theme.fg("muted", data.message.trim()));
    }
    for (const detail of data.details ?? []) {
      lines.push(theme.fg("dim", `  ${detail}`));
    }

    box.addChild(new Text(lines.join("\n"), 0, 0));

    return box;
  });
}

export function log(
  ctx: ExtensionContext,
  title: string,
  message: string,
  level: NoticeLevel = "info",
  details?: string[],
): void {
  if (ctx.mode === "tui" && ctx.hasUI && entryApi) {
    try {
      entryApi.appendEntry("bifrost-notice", {
        title,
        message,
        level,
        ...(details ? { details } : {}),
      } satisfies BifrostNotice);
      return;
    } catch {
      /* no session to attach the entry to; fall through to notify */
    }
  }
  const flat = details?.length ? `${message}\n${details.join("\n")}` : message;
  if (ctx.hasUI) {
    ctx.ui.notify(`${title}: ${flat}`, level === "success" ? "info" : level);
    return;
  }

  const output = `[bifrost] ${title}: ${flat}`;
  ({ info: console.info, success: console.log, warning: console.warn, error: console.error })[
    level
  ](output);
}
