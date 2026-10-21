import { execFile, spawn, spawnSync } from "node:child_process";

// ruleid: bifrost-no-shell-true
spawn("git status", [], { shell: true });

// ruleid: bifrost-no-shell-true
spawnSync("git status", { shell: true });

// ruleid: bifrost-no-shell-true
execFile("git", ["status"], { shell: true });

// ok: bifrost-no-shell-true
spawn("git", ["status"], { shell: false });
