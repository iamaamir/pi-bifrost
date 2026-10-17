import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAndPromptSession, promptSessionIfActive } from "../session-fallback.ts";

describe("minimal-session classifier fallback", () => {
  it("does not start a prompt when cancellation happens before the session is ready", async () => {
    const controller = new AbortController();
    controller.abort();
    let prompts = 0;
    let disposals = 0;
    const session = {
      prompt: async () => { prompts++; },
      abort: async () => {},
      getLastAssistantText: () => "late result",
      dispose: () => { disposals++; },
    };

    assert.equal(await promptSessionIfActive(session, "classifier prompt", controller.signal), undefined);
    assert.equal(prompts, 0);
    assert.equal(disposals, 1);
  });

  it("does not prompt when cancellation occurs while session creation is awaited", async () => {
    const controller = new AbortController();
    let finishCreation!: (session: {
      prompt: () => Promise<void>;
      abort: () => Promise<void>;
      getLastAssistantText: () => string;
      dispose: () => void;
    }) => void;
    let prompts = 0;
    let disposals = 0;
    const creation = new Promise<{
      prompt: () => Promise<void>;
      abort: () => Promise<void>;
      getLastAssistantText: () => string;
      dispose: () => void;
    }>((resolve) => { finishCreation = resolve; });
    const result = createAndPromptSession(() => creation, "classifier prompt", controller.signal);

    controller.abort();
    finishCreation({
      prompt: async () => { prompts++; },
      abort: async () => {},
      getLastAssistantText: () => "late result",
      dispose: () => { disposals++; },
    });

    assert.equal(await result, undefined);
    assert.equal(prompts, 0);
    assert.equal(disposals, 1);
  });

  it("aborts and ignores an in-flight prompt when the shared signal expires", async () => {
    const controller = new AbortController();
    let releasePrompt!: () => void;
    let aborts = 0;
    const session = {
      prompt: () => new Promise<void>((resolve) => { releasePrompt = resolve; }),
      abort: async () => { aborts++; releasePrompt(); },
      getLastAssistantText: () => "late result",
      dispose: () => {},
    };

    const result = promptSessionIfActive(session, "classifier prompt", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await result, undefined);
    assert.equal(aborts, 1);
  });
});
