import * as host from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";

// ModelRuntime exists on Pi; omp has no equivalent class (its registry is
// process-global), so the minimal-session transport is unavailable there.
// The module must not crash at import time on omp — degrade instead.
const ModelRuntime = (host as unknown as { ModelRuntime?: abstract new (...args: never[]) => object }).ModelRuntime;

type MinimalRuntime = object;

let runtimePromise: Promise<MinimalRuntime> | undefined;

async function getRuntime(): Promise<MinimalRuntime> {
  runtimePromise ??= (ModelRuntime as unknown as { create: () => Promise<MinimalRuntime> }).create();
  return runtimePromise;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** True when the host can spawn a minimal side session (Pi only). */
export function minimalSessionAvailable(): boolean {
  return typeof ModelRuntime === "function";
}

export async function promptWithMinimalSession(
  model: Model<Api>,
  prompt: string,
  options: {
    cwd?: string;
    systemPrompt?: string;
  } = {},
): Promise<string | undefined> {
  if (!minimalSessionAvailable()) {
    debugUnavailableOnce();
    return undefined;
  }
  const cwd = options.cwd ?? process.cwd();
  const systemPrompt = options.systemPrompt ?? "You are a helpful assistant.";
  const runtime = await getRuntime();
  const loader = new host.DefaultResourceLoader({
    cwd,
    agentDir: agentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();

  const { session } = await host.createAgentSession({
    cwd,
    modelRuntime: runtime as host.ModelRuntime,
    model,
    sessionManager: host.SessionManager.inMemory(cwd),
    resourceLoader: loader,
    noTools: "all",
  });

  try {
    await session.prompt(prompt);
    const text = session.getLastAssistantText()?.trim();
    return text ? text : undefined;
  } finally {
    session.dispose();
  }
}

let warnedUnavailable = false;
function debugUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.error("[bifrost] minimal-session transport unavailable on this host; session fallback disabled");
}
