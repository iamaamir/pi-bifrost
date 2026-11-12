import { DefaultResourceLoader, ModelRuntime, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";

let runtimePromise: Promise<ModelRuntime> | undefined;

interface PromptableSession {
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  getLastAssistantText(): string | undefined;
  dispose(): void;
}

export async function promptSessionIfActive(
  session: PromptableSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const abortSession = () => { void session.abort().catch(() => {}); };
  signal?.addEventListener("abort", abortSession, { once: true });
  try {
    if (signal?.aborted) return undefined;
    await session.prompt(prompt);
    if (signal?.aborted) return undefined;
    const text = session.getLastAssistantText()?.trim();
    return text ? text : undefined;
  } catch (error) {
    if (signal?.aborted) return undefined;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortSession);
    session.dispose();
  }
}

export async function createAndPromptSession(
  createSession: () => Promise<PromptableSession>,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const session = await createSession();
  return promptSessionIfActive(session, prompt, signal);
}

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
    signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  if (options.signal?.aborted) return undefined;
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
  if (options.signal?.aborted) return undefined;

  return createAndPromptSession(async () => {
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      noTools: "all",
    });
    return session;
  }, prompt, options.signal);
}
