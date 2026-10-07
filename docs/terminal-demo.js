// Scripted demonstration only. Commands match Bifrost, but no Pi or provider requests run here.
const terminal = document.querySelector(".demo-terminal");

if (terminal) {
  const scenes = {
    auto: {
      mode: "Auto selected", model: "bifrost/auto",
      lines: [
        ["command", "/model"], ["good", "selected: bifrost/auto"],
        ["command", "quick commit these changes"],
        ["accent", "Bifrost auto: quick → example/fast-model"],
        ["good", "Pi runs example/fast-model"],
        ["muted", "tool continuation → same physical model"],
      ],
    },
    circuit: {
      mode: "Circuit open", model: "example/backup-model",
      lines: [
        ["warn", "example/fast-model: third failure in 5 minutes"],
        ["warn", "Circuit open; state saved to project"],
        ["muted", "Failed turn ends. No automatic replay."],
        ["command", "commit these changes"],
        ["accent", "Next turn: example/fast-model skipped (open circuit)"],
        ["good", "Pi runs example/backup-model"],
        ["muted", "After cooldown → one recovery trial"],
      ],
    },
    classifier: {
      mode: "Classifier: pi-native", model: "quick → example/fast-model",
      lines: [
        ["command", "/bifrost classifier"],
        ["muted", "Choose backend: prompt · typesafe · pi-native"],
        ["muted", "Pi-native shown only on supported hosts"],
        ["good", "selected: pi-native (Pi classify API)"],
        ["command", "/bifrost classifier test"],
        ["accent", "tier: quick · backend: pi-native"],
        ["good", "Bifrost pool → example/fast-model"],
        ["muted", "Classifier picks tier, never provider model"],
      ],
    },
    physical: {
      mode: "Physical routing", model: "example/fast-model",
      lines: [
        ["command", "commit these changes"], ["accent", "rule → quick · source: regex"],
        ["good", "Pi active model → example/fast-model"],
        ["muted", "Pi sends this turn to its active model"],
      ],
    },
    setup: {
      mode: "Setup proposal", model: "models from Pi",
      lines: [
        ["command", "/bifrost init"], ["muted", "Probe available Pi models (may incur usage)"],
        ["accent", "Proposed: quick · general · frontier"],
        ["good", "Review before writing .pi/bifrost.json"],
      ],
    },
    rules: {
      mode: "Explicit route", model: "example/deep-model",
      lines: [
        ["command", "write a commit message"],
        ["accent", "rule: commit → quick pool"],
        ["good", "Pi runs example/fast-model"],
        ["command", "quick commit these changes"],
        ["accent", "tier prefix quick → removed from prompt"],
        ["good", "Pi runs example/fast-model"],
        ["command", "security audit this code"],
        ["accent", "configured direct rule → example/deep-model"],
        ["good", "Pi runs example/deep-model"],
      ],
    },
    strategies: {
      mode: "Tier strategy", model: "example/fast-model",
      lines: [
        ["muted", "quick pool: example/fast-model, example/backup-model"],
        ["muted", "strategy: cheapest (model price metadata)"],
        ["accent", "open circuits removed before selection"],
        ["good", "selected: example/fast-model"],
      ],
    },
    preview: {
      mode: "Preview only", model: "example/deep-model",
      lines: [
        ["command", "/bifrost preview security audit this code"],
        ["accent", "direct rule → example/deep-model"],
        ["good", "selected: example/deep-model"],
        ["muted", "skipped: none · no generation turn"],
      ],
    },
    control: {
      mode: "Manual control", model: "example/fast-model",
      lines: [
        ["command", "/bifrost pin"], ["good", "current model pinned for this session"],
        ["command", "quick commit these changes"], ["muted", "pinned: prompt sent unchanged"],
        ["command", "/bifrost unpin"], ["good", "routing resumed"],
        ["command", "/bifrost off"], ["muted", "routing off; this setting survives restart"],
        ["command", "/bifrost on"], ["good", "routing resumed"],
      ],
    },
    cache: {
      mode: "Cache local", model: "tier: quick",
      lines: [
        ["command", "/bifrost cache stats"],
        ["accent", "local tier decisions, not model answers"],
        ["muted", "normalized prompt words can be sensitive"],
        ["command", "/bifrost cache clear"], ["good", "classification cache cleared"],
      ],
    },
    debug: {
      mode: "Inspect routing", model: "local diagnostics",
      lines: [
        ["command", "/bifrost debug"],
        ["accent", "effective routing · classifier · reliability"],
        ["good", "openCircuits: 1"],
        ["muted", "optional local JSONL: reason, tier, model, timing"],
        ["muted", "normal traces omit raw prompt bodies"],
      ],
    },
  };

  // Mirrors the canonical entries in BIFROST_COMMAND_OPTIONS (commands.ts).
  // init -f is a completion alias, not a separate Pi dashboard entry.
  // Each choice plays an illustrative response; no command runs in Pi.
  const commands = [
    ["on", "Enable routing", "control", "Routing enabled."],
    ["off", "Disable routing", "control", "Routing disabled until /bifrost on."],
    ["pin", "Lock current model", "control", "Current physical model pinned for this session."],
    ["unpin", "Resume routing", "control", "Routing resumed for new messages."],
    ["preview", "Preview routing for a prompt (--json available)", "preview", "Shows the selected model without generating a turn."],
    ["benchmark", "Classify a benchmark prompt", "classifier", "Shows the tier without starting a generation turn."],
    ["providers", "List available providers", "setup", "Shows providers available through Pi."],
    ["probe", "Probe working models", "setup", "Checks available models; real probes can incur usage."],
    ["init", "Probe models and generate config (use -f to re-probe)", "setup", "Proposes model groups for review before writing."],
    ["classifier status", "Show classifier state", "classifier", "Shows effective backend, model, and fallback."],
    ["reload", "Reload config after editing", "setup", "Configuration reloaded from disk."],
    ["validate", "Validate loaded config and model references", "setup", "Checks loaded configuration and local registry references without probing."],
    ["inspect", "Inspect configured models and local health", "debug", "Shows local registry availability, auth presence, and reliability circuits."],
    ["cache stats", "Show classification cache", "cache", "Shows local tier-decision cache statistics."],
    ["cache clear", "Clear classification cache", "cache", "Clears stored tier decisions, not provider responses."],
    ["classifier", "Choose classifier backend", "classifier", "Choose a tier classifier; Pi-native requires host support."],
    ["classifier on", "Enable classifier", "classifier", "Configured classifier enabled."],
    ["classifier off", "Disable classifier", "classifier", "Rules and the default tier remain available."],
    ["classifier test", "Test selected classifier backend", "classifier", "Makes a fresh classifier request in Pi; usage can apply."],
    ["debug", "Show config and routing state", "debug", "Shows effective routing and reliability diagnostics."],
  ];
  for (const [value, , chapter, detail] of commands) {
    const sample = value === "benchmark" ? " review this change" : value === "preview" ? " security audit this code" : "";
    scenes[`command:${value}`] = {
      chapter,
      mode: `Command: ${value}`,
      model: scenes[chapter].model,
      lines: [["command", `/bifrost ${value}${sample}`], ["accent", detail]],
    };
  }

  const screen = terminal.querySelector("#demo-screen");
  const output = terminal.querySelector("#demo-output");
  const typed = terminal.querySelector("#demo-typed");
  const mode = terminal.querySelector("#demo-mode");
  const model = terminal.querySelector("#demo-model");
  const count = terminal.querySelector("#demo-count");
  const signal = terminal.querySelector(".demo-signal");
  const pauseButton = terminal.querySelector("#demo-pause");
  const promptButton = terminal.querySelector("#demo-prompt");
  const picker = terminal.querySelector("#demo-command-picker");
  const search = terminal.querySelector("#demo-command-search");
  const commandList = terminal.querySelector("#demo-command-list");
  const emptyMessage = terminal.querySelector(".demo-command-empty");
  const buttons = [...terminal.querySelectorAll("[data-demo-button]")];
  const chapters = [...document.querySelectorAll("[data-demo-scene]")];
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const announcement = document.querySelector("#demo-announcement");
  let active = "auto";
  let observed = "auto";
  let index = 0;
  let letter = 0;
  let timer;
  let visible = false;
  let paused = false;
  let completed = false;
  let started = false;
  let hasPlayed = false;
  let queuedScroll = false;
  let ignoreNextChapterSync = false;
  let attentionAnimation;
  let menuOpen = false;

  function appendLine(kind, text) {
    const row = document.createElement("p");
    row.className = kind;
    row.textContent = text;
    output.append(row);
    screen.scrollTop = screen.scrollHeight;
  }

  function clearTimer() {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function showCompleteScene() {
    clearTimer();
    output.replaceChildren();
    typed.textContent = "";
    for (const [kind, text] of scenes[active].lines) appendLine(kind, text);
    mode.textContent = scenes[active].mode;
    model.textContent = scenes[active].model;
    completed = true;
  }

  function canAdvance() {
    return visible && !paused && !menuOpen && !document.hidden && !motion.matches;
  }

  function schedule(delay) {
    clearTimer();
    if (canAdvance()) timer = window.setTimeout(advance, delay);
  }

  function advance() {
    if (!canAdvance()) return;
    const line = scenes[active].lines[index];
    if (!line) {
      model.textContent = scenes[active].model;
      completed = true;
      return;
    }
    const [kind, text] = line;
    if (kind === "command" && letter < text.length) {
      typed.textContent = text.slice(0, ++letter);
      schedule(/[ ,./]/.test(text[letter - 1]) ? 115 : 75);
      return;
    }
    typed.textContent = "";
    appendLine(kind, text);
    letter = 0;
    index += 1;
    schedule(kind === "command" ? 850 : kind === "warn" ? 1150 : 930);
  }

  function signalAttention() {
    if (!visible || motion.matches || !signal?.animate) return;
    attentionAnimation?.cancel();
    attentionAnimation = signal.animate([
      { opacity: 0, transform: "scaleX(0)" },
      { opacity: 0.9, transform: "scaleX(1)", offset: 0.3 },
      { opacity: 0, transform: "scaleX(1)" },
    ], { duration: 1100, easing: "ease-out" });
  }

  function showScene(name, announce = false) {
    clearTimer();
    active = name;
    index = 0;
    letter = 0;
    completed = false;
    started = visible;
    if (visible) hasPlayed = true;
    typed.textContent = "";
    output.replaceChildren();
    mode.textContent = scenes[name].mode;
    model.textContent = scenes[name].model;
    const chapterName = scenes[name].chapter ?? name;
    const chapterIndex = chapters.findIndex((item) => item.dataset.demoScene === chapterName);
    count.textContent = name.startsWith("command:") ? "COMMAND" : `${String(chapterIndex + 1).padStart(2, "0")} / ${chapters.length}`;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.demoButton === name));
    }
    for (const chapter of chapters) {
      chapter.classList.toggle("is-current", chapter.dataset.demoScene === chapterName && observed === chapterName);
    }
    if (announce) {
      announcement.textContent = `Now playing ${name.startsWith("command:") ? `/bifrost ${name.slice(8)}` : name} in the terminal walkthrough`;
      signalAttention();
    }
    if (!visible && !hasPlayed && !motion.matches) appendLine("muted", "Scroll to this section to start the terminal replay.");
    else if (motion.matches || paused || !visible) showCompleteScene();
    else schedule(400);
  }

  function syncVisibility() {
    const rail = terminal.getBoundingClientRect();
    const chapter = chapters.find((item) => item.dataset.demoScene === observed)?.getBoundingClientRect();
    const overlap = (bounds) => Math.max(0, Math.min(bounds.bottom, window.innerHeight) - Math.max(bounds.top, 0));
    const ready = chapter && overlap(rail) >= Math.min(rail.height * 0.8, window.innerHeight * 0.65)
      && overlap(chapter) >= Math.min(chapter.height * 0.65, window.innerHeight * 0.3);
    if (visible === Boolean(ready)) return;
    visible = Boolean(ready);
    clearTimer();
    if (!visible) return;
    if (!started && !motion.matches && !paused) {
      showScene(active);
      signalAttention();
    } else if (!completed) schedule(0);
  }

  function syncChapter() {
    queuedScroll = false;
    if (ignoreNextChapterSync) {
      ignoreNextChapterSync = false;
      syncVisibility();
      return;
    }
    const secondary = document.querySelector("#physical").getBoundingClientRect().top <= window.innerHeight * 0.48;
    const point = secondary
      ? window.innerWidth <= 768
        ? Math.min(window.innerHeight * 0.76, document.querySelector(".demo-rail").getBoundingClientRect().bottom + 80)
        : window.innerHeight * 0.18
      : window.innerHeight * (window.innerWidth <= 768 ? 0.76 : 0.48);
    const chapter = chapters.find((item) => {
      const bounds = item.getBoundingClientRect();
      return bounds.top <= point && bounds.bottom > point;
    });
    if (chapter && chapter.dataset.demoScene !== observed) {
      observed = chapter.dataset.demoScene;
      syncVisibility();
      showScene(observed, true);
      return;
    }
    syncVisibility();
  }

  const commandRows = new Map();
  for (const [value, description] of commands) {
    const row = document.createElement("li");
    const option = document.createElement("button");
    option.type = "button";
    option.dataset.command = value;
    option.textContent = `/bifrost ${value}`;
    const detail = document.createElement("span");
    detail.textContent = description;
    option.append(detail);
    row.append(option);
    commandList.append(row);
    commandRows.set(value, row);
  }

  function filterCommands() {
    const query = search.value.trim().toLowerCase().replace(/^\/?bifrost\s*/, "");
    let matches = 0;
    for (const [value, description] of commands) {
      const match = `${value} ${description}`.toLowerCase().includes(query);
      commandRows.get(value).hidden = !match;
      if (match) matches += 1;
    }
    emptyMessage.hidden = matches > 0;
  }

  function closeCommandPicker(restoreFocus = true) {
    if (!menuOpen) return;
    menuOpen = false;
    picker.hidden = true;
    promptButton.setAttribute("aria-expanded", "false");
    promptButton.setAttribute("aria-label", "Open Bifrost demo commands");
    if (restoreFocus) promptButton.focus();
    if (!completed) schedule(0);
  }

  function openCommandPicker() {
    if (menuOpen) return;
    clearTimer();
    menuOpen = true;
    picker.hidden = false;
    promptButton.setAttribute("aria-expanded", "true");
    promptButton.setAttribute("aria-label", "Close Bifrost demo commands");
    search.value = "";
    filterCommands();
    search.focus();
  }

  promptButton.addEventListener("click", () => {
    if (menuOpen) closeCommandPicker();
    else openCommandPicker();
  });
  search.addEventListener("input", filterCommands);
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPicker();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...commandList.querySelectorAll("li:not([hidden]) button")];
    const current = options.indexOf(document.activeElement);
    const next = event.key === "ArrowDown"
      ? options[current + 1] ?? options[0]
      : current <= 0 ? search : options[current - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  commandList.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-command]");
    if (!option) return;
    const value = option.dataset.command;
    const chapterName = scenes[`command:${value}`].chapter;
    closeCommandPicker(false);
    const beforeScroll = window.scrollY;
    chapters.find((item) => item.dataset.demoScene === chapterName).scrollIntoView({ behavior: "instant", block: "start" });
    // Keep this command's replay when the scroll event probes the next short chapter.
    ignoreNextChapterSync = window.scrollY !== beforeScroll || queuedScroll;
    observed = chapterName;
    syncVisibility();
    showScene(`command:${value}`, true);
    promptButton.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (menuOpen && !terminal.querySelector(".demo-input").contains(event.target)) closeCommandPicker(false);
  });

  buttons.forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.demoButton;
    chapters.find((item) => item.dataset.demoScene === name).scrollIntoView({ behavior: "instant", block: "start" });
    if (observed === name) {
      syncVisibility();
      showScene(name, true);
    } else syncChapter();
  }));
  terminal.querySelector("#demo-replay").addEventListener("click", () => showScene(active, true));
  pauseButton.addEventListener("click", () => {
    paused = !paused;
    pauseButton.textContent = paused ? "Play" : "Pause";
    pauseButton.setAttribute("aria-label", `${paused ? "Play" : "Pause"} terminal replay`);
    clearTimer();
    if (!paused) {
      if (completed) showScene(active);
      else schedule(0);
    }
  });
  window.addEventListener("scroll", () => {
    if (queuedScroll) return;
    queuedScroll = true;
    window.requestAnimationFrame(syncChapter);
  }, { passive: true });
  window.addEventListener("resize", syncChapter, { passive: true });
  window.addEventListener("load", syncChapter);
  document.addEventListener("visibilitychange", () => {
    clearTimer();
    if (!document.hidden && !completed) schedule(0);
  });
  motion.addEventListener("change", () => {
    if (motion.matches) {
      attentionAnimation?.cancel();
      showCompleteScene();
    } else showScene(active);
  });
  document.documentElement.classList.add("terminal-ready");
  showScene("auto");
  window.requestAnimationFrame(syncChapter);
}
