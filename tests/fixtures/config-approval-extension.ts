// Test-only command drives the production tool through real Pi's TUI context.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBifrostConfigTool, type ConfigAgentCheckResult } from "../../config-agent.ts";
import { reportText } from "../../config-agent-report.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("approval-case", {
    description: "Exercise configuration approval without provider generation",
    handler: async (_args, ctx) => {
      const tool = createBifrostConfigTool({
        extensionDir: fileURLToPath(new URL("../../", import.meta.url)),
        render: reportText,
        // This regression tests review and persistence, not reload activation.
        reload: () => true,
      });
      const toolContext: ExtensionToolContext = {
        ...ctx, tools: [], executeTool: async () => { throw new Error("Nested tools are not part of this fixture"); },
      };
      const patch = {
        schemaVersion: 2,
        description: "x".repeat(6_000) + "HIDDEN_LAST_CHANGE",
        classifier: { enabled: false },
        models: { general: ["fake/healthy"], review: ["fake/healthy"] },
        rules: [{ pattern: "review", model: "review" }],
        tierPolicies: { general: { fallbackTiers: [] } },
      };
      const checked = await tool.execute("check", { operation: "check", patch }, undefined, undefined, toolContext);
      const details = checked.details as ConfigAgentCheckResult;
      if (details.status !== "ok" || !details.guards || !details.proposalDigest) throw new Error(reportText(details));
      const applied = await tool.execute("apply", {
        operation: "apply", patch,
        proposalDigest: details.proposalDigest,
        sourceDigest: details.guards.sourceDigest ?? "absent",
        effectiveDigest: details.guards.effectiveDigest,
        catalogDigest: details.guards.catalogDigest,
      }, undefined, undefined, toolContext);
      writeFileSync(join(ctx.cwd, "approval-result.json"), JSON.stringify(applied.details));
    },
  });
}
