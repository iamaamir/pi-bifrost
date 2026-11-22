#!/usr/bin/env node
// Check a pull request body against the live PR revision and an optional list
// of removed user-visible phrases. The check is read-only: it never edits the
// PR body and never resolves review claims.
//
// Usage:
//   node scripts/check-pr-evidence.mjs <pr> [--forbid "<phrase>"]...
//
// Exit codes: 0 clean, 1 findings, 2 invalid invocation or unavailable input.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEAD_LABEL = /^\s*(?:[-*>]\s+)?(?:\*\*)?(?:(?:reviewed|final|candidate|current|exact|required|pr)\s+)?head(?:\s+(?:sha|commit|revision))?(?:\*\*)?\s*[:=]\s*(.*)$/iu;
const BASE_LABEL = /^\s*(?:[-*>]\s+)?(?:\*\*)?(?:(?:(?:original|reviewed|integrated|required|exact|current|pr|pull\s+request)\s+)*base(?:\s+(?:sha|commit|revision))?|rebase\s+targets?[^:]*|rebased\s+onto)(?:\*\*)?\s*[:=]\s*(.*)$/iu;
const SHA = /(?<![0-9a-z/-])[0-9a-f]{7,40}(?![0-9a-z-])/giu;
const NOT_APPLICABLE = /^n\/?a\b/iu;

function visibleText(text) {
  return String(text).replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
}

export function extractShas(text) {
  return [...String(text).matchAll(SHA)].map((match) => match[0].toLowerCase());
}

function labelOf(line) {
  return line
    .replace(/^\s*(?:[-*>]\s+)?/u, "")
    .replace(/\*\*/gu, "")
    .split(/[:=]/u, 1)[0]
    .trim();
}

function isHistoricalBase(label) {
  return /original|rebased\s+onto|rebase\s+targets|integrated/i.test(label);
}

export function revisionClaims(body) {
  const claims = [];
  for (const line of visibleText(body).split(/\r?\n/u)) {
    for (const [kind, pattern] of [["head", HEAD_LABEL], ["base", BASE_LABEL]]) {
      const match = pattern.exec(line);
      if (!match) continue;
      const value = visibleText(match[1]).trim();
      const shas = extractShas(value);
      if (shas.length > 0) {
        for (const sha of kind === "head" ? shas.slice(0, 1) : shas) {
          claims.push({ kind, label: labelOf(line), value: sha });
        }
      } else if (value !== "" && !NOT_APPLICABLE.test(value)) {
        claims.push({ kind, label: labelOf(line), value: null });
      }
      break;
    }
  }
  return claims;
}

function checkBaseClaim(claim, { head, liveBase, isAncestor, findings }) {
  if (claim.value === null) {
    findings.push({
      level: "error",
      message: `${claim.label} does not name a valid revision`,
    });
    return;
  }
  if (isHistoricalBase(claim.label)) {
    if (isAncestor === null) {
      findings.push({
        level: "error",
        message: `${claim.label} ${claim.value} cannot be verified locally; fetch the commit and rerun`,
      });
      return;
    }
    const relation = isAncestor(claim.value, head);
    if (relation === false) {
      findings.push({
        level: "error",
        message: `${claim.label} ${claim.value} is not an ancestor of the live head ${head}`,
      });
    } else if (relation !== true) {
      findings.push({
        level: "error",
        message: `${claim.label} ${claim.value} cannot be verified locally; fetch the commit and rerun`,
      });
    }
    return;
  }
  if (liveBase === "") {
    findings.push({
      level: "error",
      message: `${claim.label} ${claim.value} cannot be checked; no live PR base supplied`,
    });
  } else if (!liveBase.startsWith(claim.value)) {
    findings.push({
      level: "error",
      message: `${claim.label} declares ${claim.value}, but the live PR base is ${liveBase}`,
    });
  }
}

export function checkBody(body, { head, base = null, forbid = [], isAncestor = null } = {}) {
  const findings = [];
  const claims = revisionClaims(body);
  const headClaims = claims.filter((claim) => claim.kind === "head");
  const baseClaims = claims.filter((claim) => claim.kind === "base");
  const liveHead = String(head ?? "").toLowerCase();
  const liveBase = String(base ?? "").toLowerCase();

  if (headClaims.length > 0 && liveHead === "") {
    findings.push({
      level: "error",
      message: "no live PR head supplied; head claims cannot be checked",
    });
  }

  for (const claim of headClaims) {
    if (claim.value === null) {
      findings.push({
        level: "error",
        message: `${claim.label} does not name a valid revision`,
      });
    } else if (liveHead !== "" && !liveHead.startsWith(claim.value)) {
      findings.push({
        level: "error",
        message: `${claim.label} declares ${claim.value}, but the live PR head is ${head}`,
      });
    }
  }

  for (const claim of baseClaims) {
    checkBaseClaim(claim, { head, liveBase, isAncestor, findings });
  }

  const text = visibleText(body).replace(/\s+/gu, " ").toLowerCase();
  for (const phrase of forbid) {
    if (text.includes(phrase.replace(/\s+/gu, " ").toLowerCase())) {
      findings.push({ level: "error", message: `PR body contains forbidden phrase: ${phrase}` });
    }
  }

  return { head, base, claims, findings };
}

export function parseArgs(argv) {
  let pr = null;
  const forbid = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--forbid") {
      const phrase = argv[index + 1];
      if (phrase === undefined || phrase.trim() === "") {
        return { error: "--forbid needs a non-empty phrase" };
      }
      forbid.push(phrase);
      index += 1;
    } else if (argument.startsWith("--")) {
      return { error: `unknown option: ${argument}` };
    } else if (pr === null) {
      pr = argument;
    } else {
      return { error: `unexpected argument: ${argument}` };
    }
  }
  if (pr === null) return { error: "no pull request number supplied" };
  if (!/^\d+$/u.test(pr)) return { error: "pull request number must be numeric" };
  return { pr: Number(pr), forbid };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitAncestor(sha, head) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error.status === 1 ? false : null;
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(
      `usage: node scripts/check-pr-evidence.mjs <pr> [--forbid "<phrase>"]...\n${parsed.error}\n`,
    );
    return 2;
  }

  let view;
  try {
    view = JSON.parse(gh(["pr", "view", String(parsed.pr), "--json", "body,headRefOid,baseRefOid,url,state"]));
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    process.stderr.write(`gh pr view failed: ${detail}\n`);
    return 2;
  }

  const { claims, findings } = checkBody(view.body, {
    head: view.headRefOid,
    base: view.baseRefOid,
    forbid: parsed.forbid,
    isAncestor: gitAncestor,
  });

  process.stdout.write(`PR #${parsed.pr} (${view.state}) ${view.url}\n`);
  process.stdout.write(`live head ${view.headRefOid}\nlive base ${view.baseRefOid}\n`);
  for (const claim of claims) {
    process.stdout.write(`${claim.kind} claim (${claim.label}): ${claim.value ?? "(no revision)"}\n`);
  }
  const checkedPhrases = parsed.forbid.length > 0 ? parsed.forbid.join(", ") : "none";
  process.stdout.write(`forbidden phrases checked: ${checkedPhrases}\n`);

  for (const finding of findings) {
    process.stderr.write(`${finding.level === "error" ? "FAIL" : "WARN"} ${finding.message}\n`);
  }

  const errors = findings.filter((finding) => finding.level === "error").length;
  const warnings = findings.filter((finding) => finding.level === "warning").length;
  if (errors > 0) {
    process.stderr.write(`\n${errors} finding(s) (${warnings} warning(s)); update the PR body or its evidence before requesting review.\n`);
    return 1;
  }
  if (warnings > 0) {
    process.stderr.write(`\n${warnings} warning(s); no errors.\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}