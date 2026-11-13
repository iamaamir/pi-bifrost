/**
 * DELIBERATE DEFECT (negative control, do not merge): a complexity-6 function
 * with zero test coverage, so the CRAP report must flag it above the
 * threshold of 30 (CRAP = CC^2 * (1 - cov)^3 + CC = 42 at 0% coverage).
 * The only caller is behind a BIFROST_CRAP_TRAP env gate that no test sets,
 * which keeps statement coverage at zero and dead-code analysis quiet.
 */

export function crapTrapComplexPath(message: string | undefined): string {
  const parts = ["trap"];
  if (message !== undefined) parts.push(message.slice(0, 8));
  if (parts.length === 2 && parts[1] === "trap") parts.push("echo");
  switch (parts.length) {
    case 1:
      return parts[0];
    case 2:
      return parts.join("-");
    default:
      return parts.join("+");
  }
}
