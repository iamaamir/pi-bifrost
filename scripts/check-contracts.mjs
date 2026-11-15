import { readFile } from "node:fs/promises";

const sources = ["index.ts", "debug.ts"];
const allowedSubagentVariables = new Set(["PI_SUBAGENT_CHILD"]);
const readPattern = /process\.env\.(PI_SUBAGENT_[A-Z0-9_]+)/g;

const reads = [];
for (const file of sources) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(readPattern)) reads.push({ file, variable: match[1] });
}

const unsupported = reads.filter(({ variable }) => !allowedSubagentVariables.has(variable));
if (unsupported.length > 0) {
  for (const { file, variable } of unsupported) {
    console.error(`${file}: unsupported subagent environment contract ${variable}`);
  }
  process.exitCode = 1;
} else if (!reads.some(({ variable }) => variable === "PI_SUBAGENT_CHILD")) {
  console.error("No PI_SUBAGENT_CHILD producer contract read found");
  process.exitCode = 1;
} else {
  console.log(`Subagent environment contract OK: ${reads.map(({ variable }) => variable).join(", ")}`);
}
