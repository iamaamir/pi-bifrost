#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function addCount(map, rule) {
  map.set(rule, (map.get(rule) ?? 0) + 1);
}

function sorted(map) {
  return [...map]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

export function parseLintOutput(text) {
  const warningCounts = new Map();
  const errorCounts = new Map();
  for (const line of String(text).split(/\r?\n/u)) {
    // The GitHub form puts the rule in `title=` on the same line as the severity.
    const annotation = /^::(warning|error)\s+([^:\r\n]*?)::/u.exec(line);
    const consoleLine = /^.*?:\d+:\d+:\s+(warning|error)(?:\s+([a-z]+\([^)]+\)))?:/u.exec(line);
    const severity = annotation?.[1] ?? consoleLine?.[1];
    if (severity !== "warning" && severity !== "error") continue;
    const rule = annotation
      ? /\btitle=([^,\s]+)/u.exec(annotation[2])?.[1] ?? "(unclassified)"
      : consoleLine?.[2] ?? "(unclassified)";
    addCount(severity === "error" ? errorCounts : warningCounts, rule);
  }
  const warnings = sorted(warningCounts);
  const errors = sorted(errorCounts);
  return {
    warnings: { total: warnings.reduce((sum, entry) => sum + entry.count, 0), byRule: warnings },
    errors: { total: errors.reduce((sum, entry) => sum + entry.count, 0), byRule: errors },
  };
}

export function formatLintSummary(parsed) {
  const lines = ["### Lint", "", `Warnings: ${parsed.warnings.total}`, `Errors: ${parsed.errors.total}`, ""];
  for (const [label, group] of [["Warnings", parsed.warnings], ["Errors", parsed.errors]]) {
    lines.push(`${label} by rule:`);
    for (const { rule, count } of group.byRule) lines.push(`- ${rule}: ${count}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] ? readFileSync(process.argv[2], "utf8") : "";
  process.stdout.write(formatLintSummary(parseLintOutput(source)));
}
