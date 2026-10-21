import { Transform } from "node:stream";

const terminalTestEvents = new Set(["test:complete"]);
const MAX_DIAGNOSTIC_MESSAGE = 2_048;
const MAX_DIAGNOSTIC_STACK = 6_144;
const MAX_CAUSE_DEPTH = 2;

function sanitize(text, limit) {
  return text
    .replace(/((?:proxy-)?authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n]+/gim, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .slice(0, limit);
}

function diagnosticError(error, depth = 0) {
  if (typeof error === "string") return { message: sanitize(error, MAX_DIAGNOSTIC_MESSAGE) };
  if (!error || typeof error !== "object") return undefined;
  const result = {};
  if (typeof error.code === "string") result.code = sanitize(error.code, 128);
  if (typeof error.failureType === "string") result.failureType = sanitize(error.failureType, 128);
  if (typeof error.message === "string") result.message = sanitize(error.message, MAX_DIAGNOSTIC_MESSAGE);
  if (typeof error.stack === "string") result.stack = sanitize(error.stack, MAX_DIAGNOSTIC_STACK);
  if (depth < MAX_CAUSE_DEPTH && error.cause !== undefined) {
    const cause = diagnosticError(error.cause, depth + 1);
    if (cause) result.cause = cause;
  }
  return Object.keys(result).length ? result : undefined;
}

export default new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    const data = event?.data;
    if (terminalTestEvents.has(event?.type) && data?.details?.type === "test") {
      const failure = data.details.passed === true ? undefined : diagnosticError(data.details.error);
      this.push(JSON.stringify({
        type: event.type,
        name: data.name,
        file: data.file,
        line: data.line,
        passed: data.details.passed === true && data.skip !== true && data.todo !== true,
        skipped: data.skip === true,
        todo: data.todo === true,
        durationMs: data.details.duration_ms ?? null,
        ...(failure ? { failure } : {}),
      }) + "\n");
    }
    callback();
  },
});
