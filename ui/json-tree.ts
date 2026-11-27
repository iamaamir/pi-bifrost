import type { ExpandableRow } from "./expandable-rows.ts";

function jsonText(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function jsonTreeRow(key: string, value: unknown, id: string): ExpandableRow {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("JSON tree requires a JSON-serializable value");
  return buildJsonTreeRow(key, JSON.parse(serialized), id);
}

function buildJsonTreeRow(key: string, value: unknown, id: string): ExpandableRow {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    const array = Array.isArray(value);
    return {
      id, label: `${key}: ${array ? "[" : "{"}${entries.length ? (array ? "…]" : "…}") : (array ? "]" : "}")}`,
      children: entries.map(([childKey, child], i) => buildJsonTreeRow(array ? childKey : jsonText(childKey), child, `${id}-${i}`)),
    };
  }
  return { id, label: `${key}: ${jsonText(value)}` };
}

