import fs from "node:fs";

export class ConfigError extends Error {}

/** Read a JSONL history file into records. */
export function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new ConfigError(`${file}: unreadable history line (${error.message})`);
    }
  }
  return records;
}

function formatDelta(value) {
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : String(value);
}

/** Render the snapshot history as a text trend table. */
export function renderTrend(records, threshold) {
  if (records.length === 0) {
    return "No CRAP history yet. Record one with: npm run crap:record";
  }
  const lines = [
    `CRAP trend (threshold ${threshold})`,
    "",
    "Date (UTC)        Rev       Thr  Functions  Flagged  Share   Max      Δ flagged",
    "----------------  --------  ---  ---------  -------  ------  -------  ---------",
  ];
  let previous = null;
  let anyDirty = false;
  for (const record of records) {
    const delta =
      previous === null ? "-" : formatDelta(record.flagged - previous.flagged);
    if (record.dirty === true) anyDirty = true;
    lines.push(
      [
        String(record.at ?? "?").slice(0, 16).replace("T", " "),
        `${String(record.revision ?? "?").slice(0, 7)}${record.dirty === true ? "*" : ""}`.padEnd(8),
        String(record.threshold ?? "?").padStart(3),
        String(record.functions ?? "?").padStart(9),
        String(record.flagged ?? "?").padStart(7),
        `${record.percentFlagged ?? "?"}%`.padStart(6),
        String(record.max ?? "?").padStart(7),
        delta.padStart(9),
      ].join("  "),
    );
    previous = record;
  }
  if (records.length > 1) {
    const first = records[0];
    const last = records[records.length - 1];
    const delta = last.flagged - first.flagged;
    const direction =
      delta === 0 ? "unchanged" : delta > 0 ? "drifting up" : "improving";
    lines.push(
      "",
      `${records.length} snapshots ${String(first.at ?? "?").slice(0, 10)} → ` +
        `${String(last.at ?? "?").slice(0, 10)}: flagged ${first.flagged} → ` +
        `${last.flagged} (${formatDelta(delta)}), ${direction}.`,
    );
  }
  if (anyDirty) {
    lines.push(
      "",
      "A revision marked * was recorded with uncommitted changes, so it does " +
        "not describe a frozen candidate.",
    );
  }
  const thresholds = [...new Set(records.map((record) => record.threshold))];
  if (thresholds.length > 1) {
    lines.push(
      "",
      `These snapshots used different thresholds (${thresholds.join(", ")}), ` +
        "so their flagged counts are not directly comparable.",
    );
  }
  return lines.join("\n");
}
