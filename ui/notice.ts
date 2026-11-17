import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Text, Box, mixColors } from "@earendil-works/pi-tui";

type NoticeLevel = "info" | "success" | "warning" | "error";

type BifrostNotice = {
  title: string;
  message: string;
  level: NoticeLevel;
  /** Collapsed detail lines. */
  details?: string[];
  /** Full detail lines shown when the entry is expanded (ctrl+o). */
  expandedDetails?: string[];
};

let entryApi: ExtensionAPI | undefined;

export function registerBifrostNotices(pi: ExtensionAPI) {
  if (typeof pi.registerEntryRenderer !== "function" || typeof pi.appendEntry !== "function") return;
  entryApi = pi;

  pi.registerEntryRenderer("bifrost-notice", (entry, options, theme) => {
    const data = entry.data as BifrostNotice;
    // shortcut: expanded/keyHint exist in pi-coding-agent >=1.5.2; the repo pins
    // 1.4.0, so read them defensively. Upgrade when the dep is bumped.
    // Without host support the hint would name no key and `expandedDetails`
    // would be unreachable, so render the full detail inline instead.
    const hostSupportsExpand =
      typeof (options as { keyHint?: unknown }).keyHint === "function";
    const expanded = hostSupportsExpand && (options as { expanded?: boolean }).expanded === true;
    const keyHint =
      (options as { keyHint?: (keybinding: string, description: string) => string }).keyHint ??
      ((_k: string, d: string) => d);

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

    const expandable = data.expandedDetails !== undefined && hostSupportsExpand;
    const bodyLines =
      data.expandedDetails !== undefined && (expanded || !hostSupportsExpand)
        ? data.expandedDetails
        : data.details;

    if (data.message?.trim()) {
      lines.push(theme.fg("muted", data.message.trim()));
    }
    for (const detail of bodyLines ?? []) {
      lines.push(theme.fg("dim", `  ${detail}`));
    }
    if (expandable && !expanded) {
      lines.push(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
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
  expandedDetails?: string[],
): void {
  if (ctx.mode === "tui" && ctx.hasUI && entryApi) {
    try {
      entryApi.appendEntry("bifrost-notice", {
        title,
        message,
        level,
        ...(details ? { details } : {}),
        ...(expandedDetails ? { expandedDetails } : {}),
      } satisfies BifrostNotice);
      return;
    } catch {
      /* no session to attach the entry to; fall through to notify */
    }
  }
  // Fallbacks stay compact: notify is a toast and headless already prints the
  // full per-model table via uiOutput.
  const flat = details?.length ? `${message}\n${details.join("\n")}` : message;
  if (ctx.hasUI) {
    ctx.ui.notify(`${title}: ${flat}`, level === "success" ? "info" : level);
    return;
  }

  // Headless notices go to stderr like every other Bifrost diagnostic: stdout
  // may carry the caller's own machine-readable output.
  const output = `[bifrost] ${title}: ${flat}`;
  ({ info: console.error, success: console.error, warning: console.warn, error: console.error })[
    level
  ](output);
}
