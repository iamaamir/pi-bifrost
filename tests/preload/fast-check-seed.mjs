// Test-only fast-check seed preload (issue #85).
//
// Campaign runs set FC_SEED per attempt and load this module through
// `node --import` (injected via NODE_OPTIONS by scripts/campaign-run.mjs), so
// every test child process configures fast-check's global default seed and
// logs the value it applied. Assertions that pass an explicit seed option keep
// their pinned replay behavior: explicit options override the global default.
// With FC_SEED unset this module changes nothing, so the default `npm test`
// path is byte-for-byte unchanged.
import { configureGlobal, readConfigureGlobal, resetConfigureGlobal } from "fast-check";

const SIGNED_32_MIN = -2_147_483_648;
const SIGNED_32_MAX = 2_147_483_647;

/**
 * Parse an FC_SEED value. `undefined` and the empty string mean "leave
 * fast-check's defaults alone"; anything else must be a signed 32-bit integer
 * written as base-10 digits with no surrounding whitespace.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {number | undefined}
 */
export function resolveSeed(env) {
  const raw = env?.FC_SEED;
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/u.test(raw)) {
    throw new Error(`FC_SEED must be a signed32-bit integer written as base-10 digits, received: ${JSON.stringify(raw)}`);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < SIGNED_32_MIN || seed > SIGNED_32_MAX) {
    throw new Error(`FC_SEED must fit in a signed 32-bit integer, received: ${JSON.stringify(raw)}`);
  }
  return seed;
}

/**
 * Apply FC_SEED from the given environment as fast-check's global seed and
 * log the value read back from fast-check. Returns the applied seed, or
 * `undefined` when FC_SEED is unset.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {number | undefined}
 */
export function applySeed(env, { log = (line) => process.stderr.write(line + "\n") } = {}) {
  const seed = resolveSeed(env);
  if (seed === undefined) return undefined;
  configureGlobal({ seed });
  const applied = readConfigureGlobal()?.seed;
  if (applied !== seed) {
    resetConfigureGlobal();
    throw new Error(`fast-check rejected FC_SEED=${seed}; global seed read back as ${String(applied)}`);
  }
  log(`[fc-seed] FC_SEED=${seed} applied as fast-check global seed`);
  return seed;
}

// Preload side effect: `node --import` runs this before any test file loads.
applySeed(process.env);
