import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
