import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export function resolveStoragePath(
  cwd: string,
  configuredPath: string | undefined,
  defaultRelativePath: string,
): string {
  if (configuredPath) {
    if (isAbsolute(configuredPath)) return configuredPath;
    if (configuredPath.startsWith("~")) {
      return (process.env.HOME ?? "/tmp") + configuredPath.slice(1);
    }
    return join(cwd, configuredPath);
  }
  return join(cwd, defaultRelativePath);
}

export function readTextFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

export function writeTextFile(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text, "utf-8");
}

export function readJsonFile<T>(path: string): T | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  // Compact JSON: these are machine-written state files (reliability,
  // runtime state). Indentation doubled their size and stringify time.
  writeTextFile(path, JSON.stringify(value) + "\n");
}

/**
 * Atomic replacement of a file via temporary exclusive file, fsync, 
 * and atomic rename. Prevents corruption during crash.
 */
export async function writeTextFileAsync(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  
  const tmpPath = `${path}.tmp.${Math.random().toString(36).slice(2)}`;
  const handle = await fs.open(tmpPath, "w");
  await handle.writeFile(text, "utf-8");
  await handle.sync();
  await handle.close();
  
  await fs.rename(tmpPath, path);
  await fs.mkdir(dir, { recursive: true }); // ensured for fsync
  // Directory fsync for metadata persistence on some FS
  // await fs.open(dir, "r").then(h => h.sync()).then(h => h.close()); 
}

/**
 * Atomic replacement of a JSON file using writeTextFileAsync.
 */
export async function writeJsonFileAsync(path: string, value: unknown): Promise<void> {
  await writeTextFileAsync(path, JSON.stringify(value, null, 2));
}
