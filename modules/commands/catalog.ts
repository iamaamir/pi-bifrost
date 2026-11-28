/** The `preview` subcommand word, as it appears in `args` and in the registry. Single source so the parser, the completion row, and the menu row cannot drift. */
export const PREVIEW_SUB = "preview";

export interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  // Orders the dashboard and never hides a command. An entry with no `menu`
  // still appears, after the common ones. That is what makes a new registry
  // command show up in /bifrost without a second edit.
  readonly menu?: "common";
  // Marks a member of an on/off-style pair, and carries everything the
  // dashboard needs to place it: which bit of state it mirrors, which way it
  // pushes that bit, and the note it shows while pushing it is a no-op. One
  // registry entry, so a new reflected command cannot half-register.
  readonly reflects?: {
    readonly state: "enabled" | "pinned";
    readonly sets: boolean;
    readonly note: string;
  };
}

export const BIFROST_COMMAND_OPTIONS: readonly CommandSpec[] = [
  // Reflected pairs first. The dashboard puts a reflected pair ahead of every
  // other row, in the order these states are first mentioned here.
  {
    value: "on",
    description: "Enable routing",
    reflects: { state: "enabled", sets: true, note: "already on" },
  },
  {
    value: "off",
    description: "Disable routing",
    reflects: { state: "enabled", sets: false, note: "already off" },
  },
  {
    value: "pin",
    description: "Lock current model",
    reflects: { state: "pinned", sets: true, note: "already pinned" },
  },
  {
    value: "unpin",
    description: "Resume routing",
    reflects: { state: "pinned", sets: false, note: "already unpinned" },
  },
  // Common commands, in menu order. The two prompt commands lead because both
  // prefill the editor rather than run: keep them adjacent.
  {
    value: PREVIEW_SUB,
    description: "Preview routing for a prompt",
    argumentHint: `[--offline] [--trace] [--json] <prompt>`,
    menu: "common",
  },
  {
    value: "benchmark",
    description: "Classify a benchmark prompt",
    argumentHint: "<prompt>",
    menu: "common",
  },
  { value: "providers", description: "List available providers", menu: "common" },
  { value: "probe", description: "Probe working models", menu: "common" },
  {
    value: "init",
    description: "Refresh model catalog and save setup (pass -f to probe)",
    aliases: ["init -f"],
    menu: "common",
  },
  { value: "classifier status", description: "Show classifier state", menu: "common" },
  { value: "reload", description: "Reload config after editing", menu: "common" },
  {
    value: "validate",
    description: "Validate loaded config and model references",
    argumentHint: "[--json]",
    menu: "common",
  },
  {
    value: "inspect",
    description: "Inspect configured models and local health",
    argumentHint: "[--json]",
    menu: "common",
  },
  {
    value: "config reconcile",
    description: "Preview or apply exact generated model membership",
    argumentHint: "[flags]",
  },
  {
    value: "config migrate",
    description: "Preview or apply an explicit schema migration",
    argumentHint: "[--source project|workspace|user] [--apply --proposal <digest>]",
  },
  { value: "reliability", description: "Show provider cooldowns" },
  {
    value: "reliability reset",
    description: "Clear one provider cooldown",
    argumentHint: "--provider <provider-id>",
  },
  {
    value: "reliability migrate",
    description: "Prepare receipt-owned reliability v2",
    argumentHint: "[--fresh]",
  },
  // Everything else, in declaration order.
  { value: "cache stats", description: "Show classification cache" },
  { value: "cost", description: "Show recorded session usage and cost estimate" },
  // Reachable from the dashboard now that the menu is derived from the
  // registry, and still unconfirmed: this writes the cache file immediately.
  // docs/ui-enhancements.md lists "Destructive confirmation - Confirm cache
  // clear/config overwrite/long probe" as a Next item. Deliberately left as is
  // here; confirmation is a separate behavior change.
  { value: "cache clear", description: "Clear classification cache" },
  { value: "classifier", description: "Choose classifier backend" },
  { value: "classifier on", description: "Enable LLM classifier for this session" },
  { value: "classifier off", description: "Disable LLM classifier for this session" },
  { value: "classifier inherit", description: "Clear this session's classifier override" },
  { value: "classifier test", description: "Test selected classifier backend" },
  { value: "debug", description: "Show config and routing state" },
] as const;

export function getBifrostCommandCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  // Aliases are completion-only: dispatch reaches them through the parent's
  // matcher, never through this list. Flattening here also keeps the exact-match
  // early return below alias-aware.
  const entries = BIFROST_COMMAND_OPTIONS.flatMap((command) => [
    { value: command.value, description: command.description },
    ...(command.aliases ?? []).map((alias) => ({ value: alias, description: command.description })),
  ]);
  // Exact commands should submit on first Enter. Returning a completion for
  // an already-complete command makes Pi accept the suggestion first and
  // leave the command text stuck in the editor until a second Enter.
  if (entries.some((entry) => entry.value === normalized)) return null;
  const items = entries
    .filter((entry) => entry.value.startsWith(normalized))
    .map((entry) => ({
      value: entry.value,
      label: entry.value,
      description: entry.description,
    }));
  return items.length > 0 ? items : null;
}

type CommandModeState = Readonly<{ enabled: boolean; pinned: boolean }>;
type CommandGroup = "state" | "common" | "other";

interface SurfaceRow {
  readonly spec: CommandSpec;
  readonly group: CommandGroup;
  readonly inert: boolean;
  readonly note: string | null;
}

export function bifrostModePhrase(state: CommandModeState): "off" | "pinned" | "on" {
  return !state.enabled ? "off" : state.pinned ? "pinned" : "on";
}

function groupOf(spec: CommandSpec): CommandGroup {
  return spec.reflects ? "state" : spec.menu === "common" ? "common" : "other";
}

// Preserve declaration order within a group; actionable reflected commands
// lead their own pair. Keep the bare description separate from the state note.
export function commandSurface(
  state: CommandModeState,
  catalog: readonly CommandSpec[] = BIFROST_COMMAND_OPTIONS,
): SurfaceRow[] {
  const reflectedStates = catalog.map((spec) => spec.reflects?.state);
  const groups: readonly CommandGroup[] = ["state", "common", "other"];
  const rows = catalog.map((spec) => {
    const inert = spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
    return {
      spec,
      group: groupOf(spec),
      inert,
      note: inert ? spec.reflects?.note ?? null : null,
    };
  });
  const pairOrder = (row: SurfaceRow): number =>
    row.spec.reflects ? reflectedStates.indexOf(row.spec.reflects.state) : 0;
  rows.sort((a, b) =>
    groups.indexOf(a.group) - groups.indexOf(b.group)
    || pairOrder(a) - pairOrder(b)
    || Number(a.inert) - Number(b.inert),
  );
  return rows;
}

type MatchKind = "exact" | "prefix" | "spaced";

// The adapter supplies a trimmed, lower-cased subcommand for matching and
// retains the original argument text for execution.
export function matchesCommand(kind: MatchKind, word: string, sub: string): boolean {
  switch (kind) {
    case "exact": return sub === word;
    case "prefix": return sub.startsWith(word);
    case "spaced": return sub === word || sub.startsWith(word + " ");
  }
}

interface CommandRoute {
  readonly value: string;
  readonly match: (sub: string) => boolean;
}

function uniqueRoute(routes: readonly CommandRoute[], value: string): CommandRoute {
  const matches = routes.filter((route) => route.match(value));
  if (matches.length !== 1) {
    throw new Error("Bifrost: expected one route for command " + JSON.stringify(value));
  }
  return matches[0];
}

function recordName(names: Set<string>, value: string): void {
  if (names.has(value)) throw new Error("Bifrost: duplicate command or alias " + JSON.stringify(value));
  names.add(value);
}

// Validate the actual adapter routes, not a second route inventory. A grouped
// command may be served by a parent matcher when its menu row prefills arguments.
export function assertCommandRoutes(
  routes: readonly CommandRoute[],
  catalog: readonly CommandSpec[] = BIFROST_COMMAND_OPTIONS,
): void {
  const used = new Set<CommandRoute>();
  const names = new Set<string>();
  for (const spec of catalog) {
    recordName(names, spec.value);
    const route = uniqueRoute(routes, spec.value);
    if (!spec.argumentHint && route.value !== spec.value) {
      throw new Error("Bifrost: no direct dashboard route for " + JSON.stringify(spec.value));
    }
    used.add(route);
    for (const alias of spec.aliases ?? []) {
      recordName(names, alias);
      if (uniqueRoute(routes, alias) !== route) {
        throw new Error("Bifrost: alias reaches a different route " + JSON.stringify(alias));
      }
    }
  }
  for (const route of routes) {
    if (!used.has(route)) throw new Error("Bifrost: unadvertised route " + JSON.stringify(route.value));
  }
}
