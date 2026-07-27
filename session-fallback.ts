import { DefaultResourceLoader, ModelRuntime, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";

let runtimePromise: Promise<ModelRuntime> | undefined;

async function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export async function promptWithMinimalSession(
  model: Model<Api>,
  prompt: string,
  options: {
    cwd?: string;
    systemPrompt?: string;
  } = {},
): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const systemPrompt = options.systemPrompt ?? "You are a helpful assistant.";
  const runtime = await getRuntime();
  const loader = new DefaultResourceLoader({
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

  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
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
