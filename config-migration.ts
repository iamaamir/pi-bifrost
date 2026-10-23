import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_CONFIG_SOURCE_BYTES } from "./config.ts";
import { writeTextFile } from "./storage.ts";

export type ConfigMigrationSource = "project" | "workspace" | "user";

export interface ConfigMigrationRequest {
  readonly source: ConfigMigrationSource;
  readonly apply: boolean;
  readonly proposalDigest?: string;
  readonly json: boolean;
}

export type ParsedConfigMigrationRequest =
  | { readonly ok: true; readonly request: ConfigMigrationRequest }
  | { readonly ok: false };

export type ConfigMigrationPlan =
  | { readonly status: "ready"; readonly proposalDigest: string; readonly beforeVersion: 1 | null; readonly replacementBytes: Buffer }
  | { readonly status: "current" }
  | { readonly status: "blocked"; readonly reason: "invalid_config" | "unsupported_version" };

export class ConfigMigrationError extends Error {
  readonly code: "source_invalid" | "source_changed" | "backup_failed" | "apply_failed";
  readonly backupPath?: string;

  constructor(code: "source_invalid" | "source_changed" | "backup_failed" | "apply_failed", backupPath?: string) {
    super(code);
    this.name = "ConfigMigrationError";
    this.code = code;
    this.backupPath = backupPath;
  }
}

export function parseConfigMigrationArgs(args: string): ParsedConfigMigrationRequest {
  if (typeof args !== "string" || args.length > 2_048) return { ok: false };
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let source: ConfigMigrationSource = "project";
  let apply = false;
  let proposalDigest: string | undefined;
  let json = false;
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !["--source", "--apply", "--proposal", "--json"].includes(token) || seen.has(token)) return { ok: false };
    seen.add(token);
    if (token === "--apply") { apply = true; continue; }
    if (token === "--json") { json = true; continue; }
    const value = tokens[++index];
    if (!value || value.startsWith("--")) return { ok: false };
    if (token === "--source") {
      if (value !== "project" && value !== "workspace" && value !== "user") return { ok: false };
      source = value;
    } else proposalDigest = value;
  }

  if (apply !== (proposalDigest !== undefined)) return { ok: false };
  if (proposalDigest !== undefined && !/^[a-f0-9]{64}$/u.test(proposalDigest)) return { ok: false };
  return { ok: true, request: Object.freeze({ source, apply, ...(proposalDigest ? { proposalDigest } : {}), json }) };
}

export function planConfigMigration(source: ConfigMigrationSource, sourceBytes: Uint8Array): ConfigMigrationPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes)); }
  catch { return { status: "blocked", reason: "invalid_config" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "blocked", reason: "invalid_config" };

  const config = parsed as Record<string, unknown>;
  const version = config.schemaVersion;
  if (version === 2) return { status: "current" };
  if (version !== undefined && version !== 1) return { status: "blocked", reason: "unsupported_version" };

  const migrated = { ...config, schemaVersion: 2 };
  const replacementBytes = Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, "utf8");
  const proposalDigest = createHash("sha256")
    .update(source).update("\0").update(sourceBytes).update("\0").update(replacementBytes).digest("hex");
  return { status: "ready", proposalDigest, beforeVersion: version ?? null, replacementBytes };
}

export function readConfigMigrationSource(path: string): Buffer {
  let pathStat;
  try { pathStat = lstatSync(path); }
  catch { throw new ConfigMigrationError("source_invalid"); }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > MAX_CONFIG_SOURCE_BYTES) {
    throw new ConfigMigrationError("source_invalid");
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size > MAX_CONFIG_SOURCE_BYTES) {
      throw new ConfigMigrationError("source_invalid");
    }
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new ConfigMigrationError("source_changed");
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new ConfigMigrationError("source_changed");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ConfigMigrationError) throw error;
    throw new ConfigMigrationError("source_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)
      || process.platform === "win32" && code === "EPERM") return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeExactBackup(sourcePath: string, sourceBytes: Uint8Array): string {
  const directory = dirname(sourcePath);
  const backupPath = join(directory, `.${basename(sourcePath)}.${randomUUID()}.migration-backup`);
  let fd: number | undefined;
  try {
    fd = openSync(backupPath, "wx", 0o600);
    writeFileSync(fd, sourceBytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    syncDirectory(directory);
    return backupPath;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve backup error */ }
    }
    try { unlinkSync(backupPath); } catch { /* preserve backup error */ }
    throw new ConfigMigrationError("backup_failed");
  }
}

export function applyConfigMigration(
  input: {
    readonly sourcePath: string;
    readonly expectedSourceBytes: Uint8Array;
    readonly replacementBytes: Uint8Array;
  },
  // Keep post-backup replacement failures deterministic without filesystem races.
  replaceConfig: typeof writeTextFile = writeTextFile,
): string {
  const currentBytes = readConfigMigrationSource(input.sourcePath);
  if (!Buffer.from(input.expectedSourceBytes).equals(currentBytes)) throw new ConfigMigrationError("source_changed");
  const backupPath = writeExactBackup(input.sourcePath, currentBytes);
  try {
    // shortcut: digest rechecks catch stale previews, but external writers share no lock; coordinate writers if concurrent config edits become supported.
    if (!Buffer.from(input.expectedSourceBytes).equals(readConfigMigrationSource(input.sourcePath))) {
      throw new ConfigMigrationError("source_changed", backupPath);
    }
    replaceConfig(input.sourcePath, Buffer.from(input.replacementBytes).toString("utf8"));
    if (!Buffer.from(input.replacementBytes).equals(readConfigMigrationSource(input.sourcePath))) {
      throw new ConfigMigrationError("apply_failed", backupPath);
    }
    return backupPath;
  } catch (error) {
    if (error instanceof ConfigMigrationError) {
      throw error.backupPath ? error : new ConfigMigrationError(error.code, backupPath);
    }
    throw new ConfigMigrationError("apply_failed", backupPath);
  }
}
