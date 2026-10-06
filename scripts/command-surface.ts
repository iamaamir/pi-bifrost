import { BIFROST_COMMAND_OPTIONS, bifrostModePhrase, dashboardCommands } from "../commands.ts";

type CommandRow = (typeof BIFROST_COMMAND_OPTIONS)[number];
type MenuState = Parameters<typeof dashboardCommands>[0];

export type SurfaceRow = CommandRow & {
  readonly inert: boolean;
  readonly note: string | null;
};

// dashboardCommands folds a reflected command's note into `description`
// (commands.ts:1017), so its return value is authoritative for order only.
// Every field here is read from the registry, which keeps `description` bare and
// leaves `reflects` the only authority on whether a note applies.
export function buildCommandSurface(state: MenuState): SurfaceRow[] {
  return dashboardCommands(state).map((row) => {
    const spec = BIFROST_COMMAND_OPTIONS.find((candidate) => candidate.value === row.value)!;
    const inert = spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
    return { ...spec, inert, note: inert ? spec.reflects!.note : null };
  });
}

export function groupOf(row: SurfaceRow): number {
  return row.reflects ? 0 : row.menu === "common" ? 1 : 2;
}

const GROUP_LABELS = ["State toggles", "Common", "Everything else"] as const;

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "`<").replace(/>/g, ">`");
}

function commandCell(row: SurfaceRow): string {
  const hint = row.argumentHint ? ` ${row.argumentHint}` : "";
  return `\`/bifrost ${row.value}${hint}\``;
}

export function renderMarkdown(rows: readonly SurfaceRow[], state: MenuState): string {
  const total = BIFROST_COMMAND_OPTIONS.length;
  const lines = [
    `Bifrost command surface — routing ${bifrostModePhrase(state)}`,
    `${total} commands. Order matches the /bifrost dashboard; grouping is editorial.`,
    "",
    "Open the surface by typing /bifrost and pressing enter.",
  ];
  for (let tier = 0; tier < GROUP_LABELS.length; tier += 1) {
    const tierRows = rows.filter((row) => groupOf(row) === tier);
    if (tierRows.length === 0) continue;
    lines.push("", `## ${GROUP_LABELS[tier]}`, "", "| Command | Description | Note |", "|---|---|---|");
    for (const row of tierRows) {
      lines.push(`| ${commandCell(row)} | ${escapeCell(row.description)} | ${row.note ?? ""} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(rows: readonly SurfaceRow[], state: MenuState): string {
  return `${JSON.stringify(
    {
      state: { enabled: state.enabled, pinned: state.pinned },
      total: BIFROST_COMMAND_OPTIONS.length,
      groups: GROUP_LABELS.map((label, tier) => ({
        label,
        rows: rows.filter((row) => groupOf(row) === tier),
      })),
    },
    null,
    2,
  )}\n`;
}

const USAGE = "usage: command-surface [--json] [--enabled=true|false] [--pinned=true|false]";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let json = false;
  const state = { enabled: true, pinned: false };
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--enabled=")) state.enabled = arg.slice("--enabled=".length) !== "false";
    else if (arg.startsWith("--pinned=")) state.pinned = arg.slice("--pinned=".length) !== "false";
    else throw new Error(`unknown flag: ${arg}\n${USAGE}`);
  }
  const rows = buildCommandSurface(state);
  console.log(json ? renderJson(rows, state).trimEnd() : renderMarkdown(rows, state).trimEnd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "command-surface failed");
    process.exitCode = 1;
  });
}
