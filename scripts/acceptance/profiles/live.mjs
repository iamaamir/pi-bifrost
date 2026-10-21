import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE_PROMPT = "Reply with exactly BIFROST-LIVE-OK.";
const LIVE_RESPONSE = "BIFROST-LIVE-OK";
const API_HOSTS = Object.freeze({
  "openai-completions": ["api.openai.com"],
  "openai-responses": ["api.openai.com"],
  "openai-codex-responses": ["chatgpt.com"],
  "anthropic-messages": ["api.anthropic.com"],
});

export function validateLiveOptions(options = {}) {
  if (options.profile !== "live" || options.allowLive !== true) throw new Error("Live acceptance requires --profile live and --allow-live.");
  const models = options.allowModels;
  if (!Array.isArray(models) || models.length !== 1 || models.some((value) => typeof value !== "string" || /[*?]/.test(value) || !/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value))) {
    throw new Error("Live acceptance requires exactly one exact --allow-model provider/model value.");
  }
  if (new Set(models).size !== models.length) throw new Error("Live model allowlist entries must be unique.");
  const maxRequestsPerModel = options.maxRequestsPerModel ?? 4;
  const deadlineSeconds = options.deadlineSeconds ?? 90;
  if (!Number.isInteger(maxRequestsPerModel) || maxRequestsPerModel < 1 || maxRequestsPerModel > 4) {
    throw new Error("--max-requests-per-model must be an integer from 1 through 4.");
  }
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 300) {
    throw new Error("--deadline-seconds must be an integer from 1 through 300.");
  }
  return { models: [...models], maxRequestsPerModel, deadlineSeconds };
}

export function classifyLiveFailure(error) {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = Number(text.match(/\b(401|402|403|429)\b/)?.[1]);
  if (status === 401 || status === 403 || /missing (?:api )?key|authentication|credential/.test(text)) return "auth_blocked";
  if (status === 402 || status === 429 || /quota|insufficient[_ -]credits|rate[_ -]limit|usage limit/.test(text)) return "quota_blocked";
  if (/deadline|timed out|abort/.test(text)) return "deadline_failed";
  return "provider_failed";
}

function exactModelKey(model) {
  return `${model.provider}/${model.id}`;
}

function exactResponseModel(message) {
  return message?.provider && message?.model ? `${message.provider}/${message.model}` : undefined;
}

function modelFromAllowlist(runtime, key) {
  const separator = key.indexOf("/");
  const model = runtime.getPhysicalModel(key.slice(0, separator), key.slice(separator + 1));
  return model && exactModelKey(model) === key ? model : undefined;
}

function modelBaseUrl(model, provider) {
  const hosts = API_HOSTS[model.api];
  const baseUrl = model.baseUrl ?? provider.baseUrl ?? (hosts?.length === 1 ? `https://${hosts[0]}` : undefined);
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && hosts?.includes(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

function makeBudgetFetch({ context, counts, maxRequestsPerModel, baseFetch, allowedOrigins, transportFailures, deadline, onTerminalFailure }) {
  return async function budgetFetch(input, init = {}) {
    if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error("Live acceptance aborted.");
    const modelKey = context.getStore();
    if (!modelKey) throw new Error("Live transport rejected a request outside an allowlisted model dispatch.");
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (!allowedOrigins.get(modelKey)?.has(url.origin)) throw new Error("Live transport rejected a non-allowlisted origin.");
    const used = counts.get(modelKey) ?? 0;
    if (used >= maxRequestsPerModel) throw new Error("Live request budget exhausted.");
    counts.set(modelKey, used + 1);
    const deadlineSignal = init.signal;
    const response = await baseFetch(input, { ...init, redirect: "error", signal: deadlineSignal });
    if (response.status >= 300 && response.status < 400) throw new Error("Live transport rejected an HTTP redirect response.");
    if ([401, 402, 403, 429].includes(response.status)) {
      const category = response.status === 401 || response.status === 403 ? "auth_blocked" : "quota_blocked";
      transportFailures.set(modelKey, category);
      const failure = Object.assign(new Error(category), { liveCategory: category });
      onTerminalFailure(failure);
      throw failure;
    }
    return response;
  };
}

function errorCategory(error) {
  if (error?.liveCategory) return error.liveCategory;
  return classifyLiveFailure(error);
}

function writeEvidence(artifactDir, evidence) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const path = join(artifactDir, "live-evidence.json");
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function resultCase({ id, startedAt, attempts, status, detail, exclusions = [], artifacts = [] }) {
  return {
    id,
    requirements: ["live-physical-session", "live-auto-session", "live-probe-consistency", "live-restart"],
    boundary: "pinned Pi 1.0.1 AgentSession + Bifrost extension + allowlisted native provider transport",
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    attempts,
    exclusions,
    artifacts,
    ...(detail ? { detail } : {}),
  };
}

function onlyAllowedModels(models, allowedKeys) {
  return models.filter((model) => allowedKeys.has(exactModelKey(model)));
}

function clonePluginSources(root, pluginDir) {
  mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(root)) {
    if (name.endsWith(".ts")) copyFileSync(join(root, name), join(pluginDir, name));
    if (name === "logging") {
      const target = join(pluginDir, "logging");
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const file of readdirSync(join(root, "logging"))) {
        if (file.endsWith(".ts")) copyFileSync(join(root, "logging", file), join(target, file));
      }
    }
  }
  symlinkSync(join(root, "node_modules"), join(pluginDir, "node_modules"), "dir");
}

function poolsAreAllowlisted(config, allowedKeys) {
  const pools = config?.models;
  if (!pools || typeof pools !== "object" || Array.isArray(pools)) return false;
  const members = Object.values(pools).flatMap((pool) => typeof pool === "string" ? [pool] : Array.isArray(pool) ? pool : []);
  return members.length > 0 && members.every((model) => allowedKeys.has(model));
}

function safeProbeEvidence(path, allowedKeys) {
  try {
    const report = JSON.parse(requireReadFile(path));
    const results = Array.isArray(report) ? report : report.results;
    if (!Array.isArray(results)) return undefined;
    return results.map((result) => {
      const evidence = {
        model: `${result.provider}/${result.model}`,
        status: result.status === "ok" ? "ok" : result.status === "timeout" ? "timeout" : "error",
      };
      if (result.status === "error") evidence.category = classifyLiveFailure(result.error ?? "provider probe failed");
      return evidence;
    }).filter((result) => allowedKeys.has(result.model));
  } catch {
    return undefined;
  }
}

function filterReadonlyCredentials(storage, providerIds) {
  const allowed = new Set(providerIds);
  return {
    read: (providerId, options) => allowed.has(providerId) ? storage.read(providerId, options) : Promise.resolve(undefined),
    list: async (options) => (await storage.list(options)).filter((entry) => allowed.has(entry.providerId)),
    modify: async () => { throw new Error("Live acceptance credentials are read-only."); },
    delete: async () => { throw new Error("Live acceptance credentials are read-only."); },
  };
}

function hasDynamicConfigValue(value) {
  return typeof value === "string" && (value.startsWith("!") || /\$(?:[A-Za-z_{])/.test(value));
}

function containsDynamicConfig(value) {
  if (typeof value === "string") return hasDynamicConfigValue(value);
  if (Array.isArray(value)) return value.some(containsDynamicConfig);
  if (value && typeof value === "object") return Object.values(value).some(containsDynamicConfig);
  return false;
}

function isManagedCredential(credential, providerConfig) {
  const storedKey = credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim() !== "" && !hasDynamicConfigValue(credential.key);
  const configuredKey = typeof providerConfig?.apiKey === "string" && providerConfig.apiKey.trim() !== "" && !hasDynamicConfigValue(providerConfig.apiKey);
  return storedKey || configuredKey || credential?.type === "oauth";
}

function writeIsolatedProviderFiles({ isolatedDir, selectedKey, storedCredentials, storedModels }) {
  const providerId = selectedKey.slice(0, selectedKey.indexOf("/"));
  const providerConfig = storedModels.providers?.[providerId];
  const credential = storedCredentials[providerId];
  if (containsDynamicConfig(providerConfig) || containsDynamicConfig(credential)) {
    return { blocked: true };
  }
  const modelId = selectedKey.slice(selectedKey.indexOf("/") + 1);
  let isolatedProvider;
  if (providerConfig) {
    isolatedProvider = structuredClone(providerConfig);
    if (Array.isArray(isolatedProvider.models)) {
      isolatedProvider.models = isolatedProvider.models.filter((model) => model?.id === modelId);
      if (isolatedProvider.models.length !== 1) return { blocked: true };
    }
  }
  const authPath = join(isolatedDir, "auth.json");
  const modelsPath = join(isolatedDir, "models.json");
  writeFileSync(authPath, `${JSON.stringify(credential ? { [providerId]: credential } : {})}\n`, { mode: 0o600 });
  writeFileSync(modelsPath, `${JSON.stringify({ providers: isolatedProvider ? { [providerId]: isolatedProvider } : {} })}\n`, { mode: 0o600 });
  return { authPath, modelsPath: isolatedProvider ? modelsPath : null };
}

function requireReadFile(path) {
  return readFileSync(path, "utf8");
}

/** Run bounded, real Pi sessions. `dependencies` exists for offline tests only. */
export async function runProfile({ root, artifactDir, options, dependencies = {} }) {
  const parsed = validateLiveOptions(options);
  const startedAt = new Date().toISOString();
  const counts = new Map();
  const transportFailures = new Map();
  const allowedKeys = new Set(parsed.models);
  const context = new AsyncLocalStorage();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Live acceptance deadline exceeded.")), parsed.deadlineSeconds * 1000);
  timer.unref?.();
  const isolatedDir = mkdtempSync(join(tmpdir(), "bifrost-live-"));
  const oldCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let session;
  const abortForSignal = (signal) => {
    const failure = Object.assign(new Error(`Live acceptance interrupted by ${signal}.`), { liveCategory: "deadline_failed" });
    if (!deadline.signal.aborted) deadline.abort(failure);
    try { session?.abort().catch(() => {}); } catch {}
  };
  const onSigint = () => abortForSignal("SIGINT");
  const onSigterm = () => abortForSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let runtime;
  let status = "failed";
  let detail = "Live acceptance did not complete.";
  let exclusions = [];
  let savedPools;
  let probe;
  let physicalModelKey;
  let stage = "runtime_setup";
  let outcome;
  try {
    if (parsed.maxRequestsPerModel < 4) {
      status = "blocked";
      detail = "The request budget is too small for one probe, physical turn, Auto turn, and verified-pool restart.";
      return finish();
    }
    const sdk = dependencies.sdk ?? await import("@earendil-works/pi-coding-agent");
    const authStorageModule = dependencies.authStorageModule ?? await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href);
    const userAgentDir = dependencies.userAgentDir ?? sdk.getAgentDir();
    const authPath = dependencies.authPath ?? join(userAgentDir, "auth.json");
    const modelsPath = dependencies.modelsPath ?? join(userAgentDir, "models.json");
    const storedCredentials = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {};
    const storedModels = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
    const selectedKey = parsed.models[0];
    const missingManagedAuth = parsed.models.find((key) => {
      const provider = key.slice(0, key.indexOf("/"));
      return !isManagedCredential(storedCredentials[provider], storedModels.providers?.[provider]);
    });
    if (missingManagedAuth) {
      status = "blocked";
      detail = "Pi has no usable stored credential or model configuration for an allowlisted provider; ambient keys are not used.";
      exclusions.push(missingManagedAuth);
      return finish();
    }
    const isolatedAuth = writeIsolatedProviderFiles({ isolatedDir, selectedKey, storedCredentials, storedModels });
    if (isolatedAuth.blocked) {
      status = "blocked";
      detail = "Selected Pi credentials or provider/model configuration use command or environment expansion; dynamic resolution is blocked before SDK setup.";
      exclusions.push(selectedKey);
      return finish();
    }
    const expiringOAuth = parsed.models.find((key) => {
      const provider = key.slice(0, key.indexOf("/"));
      const credential = storedCredentials[provider];
      return credential?.type === "oauth" && (!Number.isFinite(credential.expires) || typeof credential.expires !== "number" || credential.expires <= Date.now() + 5 * 60 * 1000 + parsed.deadlineSeconds * 1000 + 10_000);
    });
    if (expiringOAuth) {
      status = "blocked";
      detail = "Pi OAuth credentials are expired or near expiry and require a refresh write.";
      exclusions.push(expiringOAuth);
      return finish();
    }
    runtime = await (dependencies.createRuntime ?? (async (args) => sdk.ModelRuntime.create(args)))({
      authPath: isolatedAuth.authPath,
      modelsPath: isolatedAuth.modelsPath,
      credentials: filterReadonlyCredentials(new authStorageModule.ReadOnlyAuthStorage(isolatedAuth.authPath), [selectedKey.slice(0, selectedKey.indexOf("/"))]),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal: deadline.signal,
    });

    const models = parsed.models.map((key) => modelFromAllowlist(runtime, key));
    if (models.some((model) => !model)) {
      status = "blocked";
      detail = "At least one exact allowlisted model is absent from Pi's physical model catalog.";
      exclusions = parsed.models.filter((key, index) => !models[index]);
      return finish();
    }
    const allowedOrigins = dependencies.allowedOrigins ?? new Map();
    for (const model of models) {
      if (!model.input?.includes("text") || !API_HOSTS[model.api]) {
        status = "blocked";
        detail = "An allowlisted model uses a transport outside the guarded native fetch profile.";
        exclusions.push(exactModelKey(model));
        return finish();
      }
      const provider = runtime.getProvider(model.provider);
      const baseUrl = modelBaseUrl(model, provider ?? {});
      if (!baseUrl) {
        status = "blocked";
        detail = "This profile supports only its built-in OpenAI, Codex, and Anthropic native HTTPS origins; custom and local endpoints are blocked before requests.";
        exclusions.push(exactModelKey(model));
        return finish();
      }
      const origin = new URL(baseUrl).origin;
      const available = await runtime.getAvailable(model.provider, { signal: deadline.signal });
      if (!available.some((candidate) => exactModelKey(candidate) === exactModelKey(model))) {
        status = "blocked";
        detail = "Pi has no usable stored or ambient authentication for an allowlisted model.";
        exclusions.push(exactModelKey(model));
        return finish();
      }
      const auth = await runtime.getAuth(model, { signal: deadline.signal });
      if (!auth) {
        status = "blocked";
        detail = "Pi could not resolve authentication for an allowlisted model.";
        exclusions.push(exactModelKey(model));
        return finish();
      }
      allowedOrigins.set(exactModelKey(model), new Set([origin]));
    }

    // Keep only selected native models visible to Bifrost, including its background probe.
    const byProvider = new Map();
    for (const model of models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    const baseFetch = dependencies.fetch ?? originalFetch;
    const budgetFetch = makeBudgetFetch({
      context,
      counts,
      maxRequestsPerModel: parsed.maxRequestsPerModel,
      baseFetch,
      allowedOrigins,
      transportFailures,
      deadline,
      onTerminalFailure: (failure) => {
        if (!deadline.signal.aborted) deadline.abort(failure);
        try { session?.abort().catch(() => {}); } catch {}
      },
    });
    const providers = runtime.getProviders();
    if (!providers?.length) throw new Error("Pi did not expose its registered provider catalog.");
    for (const provider of providers) {
      const selected = byProvider.get(provider.id) ?? [];
      const originalStream = provider.stream?.bind(provider);
      const originalStreamSimple = provider.streamSimple?.bind(provider);
      const narrow = (models) => selected.length ? onlyAllowedModels(models, allowedKeys) : [];
      const requestOptions = (options) => ({
        ...options,
        transport: "sse",
        fetch: budgetFetch,
        maxRetries: 0,
        signal: options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal,
      });
      const blockUnselected = () => { throw new Error("Live acceptance blocked a provider outside the exact model allowlist."); };
      runtime.registerNativeProvider({
        ...provider,
        getModels: () => narrow(provider.getModels()),
        getAllModels: () => narrow(provider.getAllModels?.() ?? provider.getModels()),
        stream: selected.length && originalStream ? (model, transcript, options) => context.run(exactModelKey(model), () => originalStream(model, transcript, requestOptions(options))) : blockUnselected,
        streamSimple: selected.length && originalStreamSimple ? (model, transcript, options) => context.run(exactModelKey(model), () => originalStreamSimple(model, transcript, requestOptions(options))) : blockUnselected,
      });
    }
    const visibleModels = runtime.getModels();
    if (visibleModels.some((model) => !allowedKeys.has(exactModelKey(model))) || parsed.models.some((key) => !visibleModels.some((model) => exactModelKey(model) === key))) throw new Error("Pi provider catalog could not be restricted to the exact model allowlist.");

    globalThis.fetch = (...args) => {
      const modelKey = context.getStore();
      if (!modelKey) throw new Error("Live acceptance blocked unscoped network access.");
      return budgetFetch(...args);
    };
    globalThis.WebSocket = class BlockedLiveWebSocket {
      constructor() { throw new Error("Live acceptance blocks WebSocket transports; use bounded SSE."); }
    };

    const workDir = join(isolatedDir, "workspace");
    const agentDir = join(isolatedDir, "agent");
    const pluginDir = join(isolatedDir, "extension");
    mkdirSync(join(workDir, ".pi"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    clonePluginSources(root, pluginDir);
    writeFileSync(join(pluginDir, "bifrost.json"), JSON.stringify({
      enabled: true,
      default: "general",
      strategy: "first",
      categoryStrategies: { quick: "random", general: "first", frontier: "first" },
      classifier: { enabled: false },
      cache: { enabled: false },
      debug: { enabled: false },
      models: { quick: [], general: [], frontier: [] },
    }), { mode: 0o600 });
    process.chdir(workDir);

    const selectedModel = models[0];
    physicalModelKey = exactModelKey(selectedModel);
    const settingsManager = sdk.SettingsManager.inMemory({
      transport: "sse",
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      defaultTools: [],
    });
    const createSession = async () => {
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: workDir,
        agentDir,
        additionalExtensionPaths: [join(pluginDir, "index.ts")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const created = await sdk.createAgentSession({
        cwd: workDir,
        agentDir,
        model: selectedModel,
        thinkingLevel: "off",
        noTools: "all",
        modelRuntime: runtime,
        resourceLoader,
        sessionManager: sdk.SessionManager.inMemory(workDir),
        settingsManager,
      });
      if (!runtime.getModel("bifrost", "auto")) throw new Error("Bifrost Auto was not registered by the loaded Pi extension.");
      return created.session;
    };

    session = await createSession();
    stage = "physical";
    const physicalStart = new Map(counts);
    const physicalText = await runPrompt(session, LIVE_PROMPT, deadline, parsed.deadlineSeconds);
    const physicalMessage = latestAssistant(session);
    outcome = {
      physicalMarkerMatches: physicalText.trim() === LIVE_RESPONSE,
      physicalModelMatches: exactResponseModel(physicalMessage) === physicalModelKey,
      physicalStopReason: physicalMessage?.stopReason ?? "missing",
      physicalHasErrorMessage: typeof physicalMessage?.errorMessage === "string",
    };
    assertCompletedLiveTurn(physicalMessage, "physical");
    if (physicalText.trim() !== LIVE_RESPONSE || exactResponseModel(physicalMessage) !== physicalModelKey) throw Object.assign(new Error("Pi physical session did not complete with the required response on the explicitly selected physical model."), { liveCategory: physicalMessage?.errorMessage ? classifyLiveFailure(physicalMessage.errorMessage) : undefined });
    const physicalAttempts = attemptsSince(counts, physicalStart);

    // Bifrost schedules its bootstrap probe from the first real session input hook.
    // Wait for the persisted result before attempting the Auto journey.
    const probePath = join(workDir, ".pi", "bifrost-probe.json");
    stage = "probe";
    const bootstrapWait = await waitForFile(probePath, deadline.signal, parsed.deadlineSeconds);
    probe = bootstrapWait ? safeProbeEvidence(probePath, allowedKeys) : undefined;
    if (!probe || models.some((model) => !probe.some((entry) => entry.model === exactModelKey(model) && entry.status === "ok"))) {
      const failedProbe = probe?.find((entry) => entry.status !== "ok");
      if (failedProbe) throw Object.assign(new Error("probe failed"), { liveCategory: failedProbe.category ?? (failedProbe.status === "timeout" ? "deadline_failed" : "provider_failed") });
      throw new Error("Bifrost did not persist a complete successful allowlisted probe report.");
    }

    const autoModel = runtime.getModel("bifrost", "auto");
    await session.setModel(autoModel);
    stage = "auto";
    const autoStart = new Map(counts);
    const autoText = await runPrompt(session, `general: ${LIVE_PROMPT}`, deadline, parsed.deadlineSeconds);
    const autoMessage = latestAssistant(session);
    outcome = { autoMarkerMatches: autoText.trim() === LIVE_RESPONSE, autoModelMatches: exactResponseModel(autoMessage) === physicalModelKey, autoStopReason: autoMessage?.stopReason ?? "missing", autoHasErrorMessage: typeof autoMessage?.errorMessage === "string" };
    assertCompletedLiveTurn(autoMessage, "Auto");
    if (autoText.trim() !== LIVE_RESPONSE || exactResponseModel(autoMessage) !== physicalModelKey) throw Object.assign(new Error("Bifrost Auto did not complete with the required response on the configured allowlisted physical model."), { liveCategory: autoMessage?.errorMessage ? classifyLiveFailure(autoMessage.errorMessage) : undefined });
    const autoAttempts = attemptsSince(counts, autoStart);

    const savedConfigPath = join(workDir, ".pi", "bifrost.json");
    stage = "saved_pools";
    const savedConfig = JSON.parse(readFileSync(savedConfigPath, "utf8"));
    if (!poolsAreAllowlisted(savedConfig, allowedKeys)) throw new Error("Saved Bifrost pools are empty or include a model outside the exact allowlist.");
    savedPools = Object.fromEntries(Object.entries(savedConfig.models).map(([tier, pool]) => [tier, typeof pool === "string" ? [pool] : pool]));

    session.dispose();
    stage = "restart";
    session = await createSession();
    await session.setModel(runtime.getModel("bifrost", "auto"));
    const restartStart = new Map(counts);
    const restartText = await runPrompt(session, `general: ${LIVE_PROMPT}`, deadline, parsed.deadlineSeconds);
    const restartMessage = latestAssistant(session);
    outcome = { restartMarkerMatches: restartText.trim() === LIVE_RESPONSE, restartModelMatches: exactResponseModel(restartMessage) === physicalModelKey, restartStopReason: restartMessage?.stopReason ?? "missing", restartHasErrorMessage: typeof restartMessage?.errorMessage === "string" };
    assertCompletedLiveTurn(restartMessage, "restarted Auto");
    if (restartText.trim() !== LIVE_RESPONSE || exactResponseModel(restartMessage) !== physicalModelKey) throw Object.assign(new Error("Restarted Pi session did not complete with the required response on the saved verified pool."), { liveCategory: restartMessage?.errorMessage ? classifyLiveFailure(restartMessage.errorMessage) : undefined });
    const restartAttempts = attemptsSince(counts, restartStart);
    status = "passed";
    detail = "Pinned Pi physical, Auto, verified-probe, saved-pool, and restart journeys completed on the exact allowlisted model.";
    return finish({ physicalAttempts, autoAttempts, restartAttempts, savedPools });
  } catch (error) {
    const category = errorCategory(error) === "provider_failed" ? [...transportFailures.values()].at(-1) ?? "provider_failed" : errorCategory(error);
    status = category === "auth_blocked" || category === "quota_blocked" ? "blocked" : "failed";
    detail = category === "auth_blocked" ? "Pi authentication is missing, expired, or requires a credential write." : category === "quota_blocked" ? "The provider reported a usage or rate limit; no further calls were sent." : category === "deadline_failed" ? "The bounded live deadline expired; pending work was aborted." : "A required physical, Auto, probe, saved-pool, or restart assertion failed.";
    detail += ` Stage: ${stage}; category: ${category}; requests: ${[...counts.values()].reduce((sum, count) => sum + count, 0)}.`;
    if (outcome) detail += ` Response: ${Object.entries(outcome).map(([key, value]) => `${key}=${value}`).join(", ")}.`;
    return finish();
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    clearTimeout(timer);
    deadline.abort();
    try { session?.dispose(); } catch {}
    if (runtime?.registerNativeProvider) { /* runtime is isolated and discarded */ }
    process.chdir(oldCwd);
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    rmSync(isolatedDir, { recursive: true, force: true });
  }

  function finish(extra = {}) {
    const artifacts = [];
    const evidence = {
      profile: "live",
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      allowlistedModels: parsed.models,
      attempts: Object.fromEntries(counts),
      maxRequestsPerModel: parsed.maxRequestsPerModel,
      deadlineSeconds: parsed.deadlineSeconds,
      toolCount: 0,
      transport: "Pi ModelRuntime native provider over guarded SSE/fetch",
      providerCostLimit: "No hard provider token or spend ceiling is guaranteed by this profile.",
      ...(probe ? { probe } : {}),
      ...(savedPools ? { savedPools } : {}),
      ...(outcome ? { outcome } : {}),
      ...extra,
      detail,
    };
    const file = writeEvidence(artifactDir, evidence);
    artifacts.push(basename(file));
    return { cases: [resultCase({ id: "live-session-journeys", startedAt, attempts: Object.fromEntries(counts), status, detail, exclusions, artifacts })] };
  }
}

function latestAssistant(session) {
  const messages = session.messages ?? [];
  return [...messages].reverse().find((message) => message.role === "assistant");
}

function categorizedSessionError(message) {
  const error = new Error("Pi session provider request failed.");
  error.liveCategory = classifyLiveFailure(message.errorMessage ?? "provider request failed");
  return error;
}

function assertCompletedLiveTurn(message, stage) {
  if (message?.stopReason === "error") throw categorizedSessionError(message);
  if (message?.stopReason !== "stop") throw Object.assign(new Error(`Pi ${stage} session ended with an unsupported stop reason.`), { liveCategory: "provider_failed" });
}

function attemptsSince(counts, before) {
  return Object.fromEntries([...counts].map(([key, count]) => [key, count - (before.get(key) ?? 0)]).filter(([, count]) => count > 0));
}

async function runPrompt(session, prompt, deadline, deadlineSeconds) {
  if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error("Live deadline aborted.");
  const pending = session.prompt(prompt, { expandPromptTemplates: false });
  const timer = setTimeout(() => session.abort().catch(() => {}), deadlineSeconds * 1000);
  let onAbort;
  try {
    await Promise.race([pending, new Promise((_, reject) => {
      onAbort = () => reject(deadline.signal.reason ?? new Error("deadline"));
      deadline.signal.addEventListener("abort", onAbort, { once: true });
    })]);
    const text = session.getLastAssistantText();
    return typeof text === "string" ? text : "";
  } finally {
    clearTimeout(timer);
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
  }
}

async function waitForFile(path, signal, timeoutSeconds) {
  const expiresAt = Date.now() + timeoutSeconds * 1000;
  while (!signal.aborted && Date.now() < expiresAt) {
    if (existsSync(path)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return false;
}
