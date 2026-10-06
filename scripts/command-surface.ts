import { BIFROST_COMMAND_OPTIONS, dashboardCommands } from "../commands.ts";

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

export function statePhrase(state: MenuState): string {
  return state.pinned ? "pinned" : state.enabled ? "on" : "off";
}
