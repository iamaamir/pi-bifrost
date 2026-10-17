#!/usr/bin/env node
import { runAcceptance } from "./acceptance.mjs";

await runAcceptance(["--profile", "deterministic", ...process.argv.slice(2)]);
