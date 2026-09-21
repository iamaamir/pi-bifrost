const gatewayCanvas = document.querySelector("#gateway-canvas");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupGatewayAnimation(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const routes = [];
  let animationFrame;
  let isRunning = false;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let pointerTargetX = 0;
  let pointerTargetY = 0;
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;

  function createRoutes() {
    const lanes = [-2.8, -2.1, -1.35, -0.55, 0.35, 1.2, 2.15];
    routes.length = 0;
    lanes.forEach((lane, index) => {
      routes.push({
        lane,
        phase: (index * 0.17 + 0.08) % 1,
        speed: 0.018 + index * 0.002,
        hue: index % 3 === 0 ? "violet" : "blue",
      });
    });
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    createRoutes();
    draw(0);
  }

  function gatewayPosition() {
    if (!reducedMotionQuery.matches) {
      pointerOffsetX += (pointerTargetX - pointerOffsetX) * 0.035;
      pointerOffsetY += (pointerTargetY - pointerOffsetY) * 0.035;
    }

    return {
      x: (width > 720 ? width * 0.72 : width * 0.5) + pointerOffsetX,
      y: height * 0.28 + pointerOffsetY,
      scale: Math.min(width, height),
    };
  }

  function routePoint(route, progress, gateway) {
    const spread = gateway.scale * 0.055;
    const start = {
      x: -width * 0.08,
      y: gateway.y + route.lane * spread * 1.8,
    };
    const portal = {
      x: gateway.x,
      y: gateway.y + route.lane * spread * 0.2,
    };
    const end = {
      x: width * 1.08,
      y: gateway.y + route.lane * spread * 1.45,
    };

    if (progress < 0.5) {
      return cubicPoint(
        start,
        { x: width * 0.2, y: start.y - route.lane * spread * 0.2 },
        { x: width * 0.52, y: portal.y + route.lane * spread * 0.55 },
        portal,
        progress * 2,
      );
    }

    return cubicPoint(
      portal,
      { x: width * 0.79, y: portal.y - route.lane * spread * 0.5 },
      { x: width * 0.91, y: end.y + route.lane * spread * 0.1 },
      end,
      (progress - 0.5) * 2,
    );
  }

  function cubicPoint(start, controlOne, controlTwo, end, progress) {
    const inverse = 1 - progress;
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * progress * controlOne.x +
        3 * inverse * progress ** 2 * controlTwo.x +
        progress ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * progress * controlOne.y +
        3 * inverse * progress ** 2 * controlTwo.y +
        progress ** 3 * end.y,
    };
  }

  function drawRoute(route, gateway, time) {
    const spread = gateway.scale * 0.055;
    const startY = gateway.y + route.lane * spread * 1.8;
    const portalY = gateway.y + route.lane * spread * 0.2;
    const endY = gateway.y + route.lane * spread * 1.45;
    const alpha = route.hue === "violet" ? 0.12 : 0.16;

    context.beginPath();
    context.moveTo(-width * 0.08, startY);
    context.bezierCurveTo(
      width * 0.2,
      startY - route.lane * spread * 0.2,
      width * 0.52,
      portalY + route.lane * spread * 0.55,
      gateway.x,
      portalY,
    );
    context.bezierCurveTo(
      width * 0.79,
      portalY - route.lane * spread * 0.5,
      width * 0.91,
      endY + route.lane * spread * 0.1,
      width * 1.08,
      endY,
    );
    context.strokeStyle =
      route.hue === "violet"
        ? `rgba(158, 132, 212, ${alpha})`
        : `rgba(112, 172, 208, ${alpha})`;
    context.lineWidth = 0.8;
    context.stroke();

    for (let trail = 0; trail < 3; trail += 1) {
      const progress = (time * route.speed + route.phase - trail * 0.018 + 1) % 1;
      const point = routePoint(route, progress, gateway);
      const size = trail === 0 ? 1.9 : 1.2 - trail * 0.2;
      context.beginPath();
      context.arc(point.x, point.y, size, 0, Math.PI * 2);
      context.fillStyle =
        route.hue === "violet"
          ? `rgba(196, 177, 240, ${0.48 - trail * 0.12})`
          : `rgba(183, 222, 242, ${0.58 - trail * 0.14})`;
      context.fill();
    }
  }

  function routePulse(route, time) {
    const progress = (time * route.speed + route.phase) % 1;
    const distance = Math.abs(progress - 0.5);
    return Math.exp(-(distance * distance) / 0.0008);
  }

  function drawGateway(gateway, time, pulse) {
    const radiusX = gateway.scale * 0.075;
    const radiusY = gateway.scale * 0.19;
    const pulseStrength = pulse * 0.12;
    const halo = context.createRadialGradient(
      gateway.x,
      gateway.y,
      0,
      gateway.x,
      gateway.y,
      radiusY * 1.7,
    );
    halo.addColorStop(0, `rgba(112, 172, 208, ${0.1 + pulseStrength})`);
    halo.addColorStop(0.42, `rgba(112, 172, 208, ${0.025 + pulseStrength * 0.3})`);
    halo.addColorStop(1, "rgba(112, 172, 208, 0)");
    context.fillStyle = halo;
    context.beginPath();
    context.arc(gateway.x, gateway.y, radiusY * 1.7, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.translate(gateway.x, gateway.y);
    context.globalCompositeOperation = "lighter";
    for (let ring = 0; ring < 3; ring += 1) {
      context.save();
      context.rotate(time * (ring % 2 === 0 ? 0.025 : -0.018) + ring * 0.9);
      context.beginPath();
      context.ellipse(
        0,
        0,
        radiusX + ring * gateway.scale * 0.012,
        radiusY + ring * gateway.scale * 0.018,
        0,
        ring * 0.7,
        Math.PI * 1.72 + ring * 0.3,
      );
      context.strokeStyle = `rgba(${ring === 1 ? "166, 143, 220" : "128, 191, 220"}, ${0.19 - ring * 0.035 + pulse * 0.11})`;
      context.lineWidth = ring === 1 ? 1.1 + pulse * 1.2 : 0.7 + pulse * 0.6;
      context.stroke();
      if (ring === 1 && pulse > 0.02) {
        context.beginPath();
        context.ellipse(0, 0, radiusX * (1 + pulse * 0.28), radiusY * (1 + pulse * 0.18), 0, 0, Math.PI * 2);
        context.strokeStyle = `rgba(196, 177, 240, ${pulse * 0.16})`;
        context.lineWidth = 1;
        context.stroke();
      }
      context.restore();
    }
    context.restore();
  }

  function draw(timestamp) {
    const time = timestamp * 0.001;
    context.clearRect(0, 0, width, height);
    const gateway = gatewayPosition();
    const pulse = routes.reduce(
      (strongest, route) => Math.max(strongest, routePulse(route, time)),
      0,
    );
    drawGateway(gateway, time, pulse);
    routes.forEach((route) => drawRoute(route, gateway, time));
  }

  function stop() {
    if (!isRunning) return;
    window.cancelAnimationFrame(animationFrame);
    isRunning = false;
  }

  function start() {
    if (isRunning || document.hidden) return;
    if (reducedMotionQuery.matches) {
      draw(0);
      return;
    }
    isRunning = true;
    const animate = (timestamp) => {
      if (!isRunning) return;
      draw(timestamp);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    if (reducedMotionQuery.matches || event.pointerType !== "mouse") return;
    pointerTargetX = (event.clientX / width - 0.5) * width * 0.018;
    pointerTargetY = (event.clientY / height - 0.5) * height * 0.018;
  }, { passive: true });
  window.addEventListener("blur", () => {
    pointerTargetX = 0;
    pointerTargetY = 0;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  reducedMotionQuery.addEventListener("change", () => {
    stop();
    start();
  });
  start();
}

if (gatewayCanvas) setupGatewayAnimation(gatewayCanvas);

const jevCanvas = document.querySelector("#jev-canvas");

function setupJevAnimation(canvas) {
  const context = canvas.getContext("2d");
  const caption = document.querySelector("#jev-caption");
  const stageLabel = document.querySelector("#jev-stage-label");
  const stageDetail = document.querySelector("#jev-stage-detail");
  const toggle = document.querySelector("#jev-toggle");
  const toggleLabel = document.querySelector("#jev-toggle-label");

  if (!context || !caption || !stageLabel || !stageDetail || !toggle || !toggleLabel) return;

  const stages = [
    {
      label: "01 · Prompt and criteria enter Jev",
      detail: "Jev sees the current prompt and configured tier criteria, not Bifrost's provider model pool.",
    },
    {
      label: "02 · Jev returns a tier judgment",
      detail: "The result contains one configured tier, probabilities, and confidence. It does not contain an exact provider model.",
    },
    {
      label: "03 · Bifrost opens that configured pool",
      detail: "Only models you placed in the selected tier become candidates for this turn.",
    },
    {
      label: "04 · Bifrost selects and Pi activates",
      detail: "Reliability filtering removes unhealthy candidates, then your tier strategy chooses the exact model Pi activates.",
    },
  ];
  const colors = {
    blue: "#75b5dc",
    violet: "#a994d6",
    mint: "#85c8aa",
    amber: "#d6ad72",
    line: "#31404b",
    faint: "#7b8a94",
    white: "#e4e8ea",
  };
  const stageDuration = 1500;
  const totalDuration = stageDuration * stages.length;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let elapsed = 0;
  let lastTimestamp = 0;
  let currentStage = 0;
  let animationFrame;
  let transitionTimer;
  let isRunning = false;
  let isVisible = false;
  let hasStarted = false;
  let isComplete = false;

  function ease(progress) {
    return 1 - (1 - progress) ** 4;
  }

  function nodePositions() {
    if (width < 440) {
      return [
        [width * 0.2, height * 0.16],
        [width * 0.5, height * 0.32],
        [width * 0.8, height * 0.49],
        [width * 0.5, height * 0.66],
        [width * 0.2, height * 0.83],
      ];
    }
    return [0.08, 0.29, 0.5, 0.71, 0.92].map((x) => [width * x, height * 0.5]);
  }

  function drawLine(start, end, color, lineWidth, alpha = 1, progress = 1) {
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(...start);
    context.lineTo(
      start[0] + (end[0] - start[0]) * progress,
      start[1] + (end[1] - start[1]) * progress,
    );
    context.stroke();
    context.restore();
  }

  function drawOrb(x, y, radius, color, glow = 0, alpha = 1) {
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = glow;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawLabel(text, x, y, color) {
    context.fillStyle = color;
    context.font = "11px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.fillText(text, x, y);
  }

  function drawNode(index, point, active) {
    const [x, y] = point;
    const glow = active ? 14 : 0;
    context.save();
    context.globalAlpha = active ? 1 : 0.48;
    context.lineWidth = 1.5;
    if (index === 0) {
      drawOrb(x, y, 7, colors.blue, glow);
    } else if (index === 1) {
      context.translate(x, y);
      context.rotate(Math.PI / 4);
      context.strokeStyle = colors.violet;
      context.strokeRect(-10, -10, 20, 20);
    } else if (index === 2) {
      context.strokeStyle = colors.amber;
      context.beginPath();
      context.arc(x, y, 14, 0, Math.PI * 2);
      context.stroke();
      drawOrb(x, y, 3, colors.amber, glow);
    } else if (index === 3) {
      drawOrb(x - 8, y + 4, 4, colors.blue, glow);
      drawOrb(x, y - 5, 4, colors.amber, glow);
      drawOrb(x + 8, y + 4, 4, colors.violet, glow);
    } else {
      context.strokeStyle = colors.mint;
      context.beginPath();
      context.arc(x, y, 15, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(x, y, 8, 0, Math.PI * 2);
      context.stroke();
      if (active) drawOrb(x, y, 4, colors.mint, 16);
    }
    context.restore();
    const labels = ["prompt", "Jev", "tier", "configured pool", "Pi model"];
    const labelY = width < 440 && index === 4 ? y - 23 : y + 31;
    drawLabel(labels[index], x, labelY, active ? colors.white : colors.faint);
  }

  function applyStage(stage, immediate = false) {
    if (stage === currentStage && !immediate) return;
    window.clearTimeout(transitionTimer);
    const update = () => {
      currentStage = stage;
      stageLabel.textContent = stages[stage].label;
      stageDetail.textContent = stages[stage].detail;
      caption.classList.remove("jev-s0", "jev-s1", "jev-s2", "jev-s3");
      caption.classList.add(`jev-s${stage}`);
      caption.classList.remove("is-transitioning");
    };
    if (immediate || reducedMotionQuery.matches) {
      update();
      return;
    }
    caption.classList.add("is-transitioning");
    transitionTimer = window.setTimeout(update, 180);
  }

  function drawScene() {
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    const points = nodePositions();
    const finalFrame = isComplete || reducedMotionQuery.matches;
    const stage = finalFrame
      ? stages.length - 1
      : Math.min(stages.length - 1, Math.floor(elapsed / stageDuration));
    const stageProgress = finalFrame
      ? 1
      : (elapsed - stage * stageDuration) / stageDuration;
    const traveled = ease(Math.min(1, stageProgress / 0.72));

    for (let index = 0; index < points.length - 1; index += 1) {
      drawLine(points[index], points[index + 1], colors.line, 7, 0.5);
      if (finalFrame || index < stage) {
        drawLine(points[index], points[index + 1], colors.mint, 2, 0.8);
      } else if (index === stage) {
        drawLine(points[index], points[index + 1], colors.blue, 2.2, 0.95, traveled);
      }
    }

    points.forEach((point, index) => drawNode(index, point, finalFrame || index <= stage));

    if (!finalFrame) {
      const start = points[stage];
      const end = points[stage + 1];
      drawOrb(
        start[0] + (end[0] - start[0]) * traveled,
        start[1] + (end[1] - start[1]) * traveled,
        5,
        colors.white,
        18,
        Math.min(1, stageProgress / 0.12),
      );
    }

    applyStage(stage);
  }

  function setToggleState(complete) {
    toggleLabel.textContent = complete ? "Replay" : "Skip";
    toggle.setAttribute(
      "aria-label",
      `${complete ? "Replay" : "Skip"} Jev illustration animation`,
    );
  }

  function finish() {
    window.cancelAnimationFrame(animationFrame);
    isRunning = false;
    isComplete = true;
    elapsed = totalDuration;
    lastTimestamp = 0;
    applyStage(stages.length - 1, true);
    setToggleState(true);
    drawScene();
  }

  function stop() {
    if (!isRunning) return;
    window.cancelAnimationFrame(animationFrame);
    isRunning = false;
    lastTimestamp = 0;
  }

  function start() {
    if (
      isRunning ||
      isComplete ||
      reducedMotionQuery.matches ||
      !isVisible ||
      document.hidden
    ) return;
    isRunning = true;
    hasStarted = true;
    const animate = (timestamp) => {
      if (!isRunning) return;
      if (lastTimestamp) elapsed += timestamp - lastTimestamp;
      lastTimestamp = timestamp;
      if (elapsed >= totalDuration) {
        finish();
        return;
      }
      drawScene();
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.round(bounds.width);
    const nextHeight = Math.round(bounds.height);
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (
      nextWidth === width &&
      nextHeight === height &&
      nextPixelRatio === pixelRatio
    ) return;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = nextPixelRatio;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawScene();
  }

  function syncAnimation() {
    if (reducedMotionQuery.matches) {
      finish();
      return;
    }
    if (document.hidden || !isVisible) {
      stop();
      return;
    }
    start();
  }

  toggle.addEventListener("click", () => {
    if (!isComplete) {
      finish();
      return;
    }
    isComplete = false;
    elapsed = 0;
    currentStage = 0;
    applyStage(0, true);
    setToggleState(false);
    drawScene();
    start();
  });

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry.isIntersecting;
      if (isVisible && !hasStarted) applyStage(0, true);
      syncAnimation();
    },
    { rootMargin: "160px 0px" },
  );
  visibilityObserver.observe(canvas);

  document.addEventListener("visibilitychange", syncAnimation);
  reducedMotionQuery.addEventListener("change", () => {
    if (reducedMotionQuery.matches) finish();
    else syncAnimation();
  });
  resize();
  applyStage(0, true);
  drawScene();
}

if (jevCanvas) setupJevAnimation(jevCanvas);

const bridgeCanvas = document.querySelector("#bridge");

function setupBridgeAnimation(canvas) {
  const context = canvas.getContext("2d");
  const caption = document.querySelector("#bridge-caption");
  const stageLabel = document.querySelector("#bridge-stage-label");
  const stageDetail = document.querySelector("#bridge-stage-detail");
  const toggle = document.querySelector("#bridge-toggle");
  const toggleLabel = document.querySelector("#bridge-toggle-label");

  if (!context || !caption || !stageLabel || !stageDetail || !toggle || !toggleLabel) return;

  const stages = [
    {
      label: "01 · Request reaches Bifrost",
      detail: "Bifrost resolves a configured tier, then checks candidate health before Pi generates a response.",
    },
    {
      label: "02 · Open circuit blocks failed model",
      detail: "Repeated failures persist across restarts. The unavailable path stays visible, but receives no request.",
    },
    {
      label: "03 · Healthy candidate becomes active",
      detail: "Bifrost applies the tier strategy, activates Pi's model, and sends the original prompt once.",
    },
    {
      label: "04 · Recovery uses one controlled trial",
      detail: "After cooldown, one new matching request tests the half-open model. Success closes the circuit; failure extends cooldown.",
    },
  ];
  const colors = {
    blue: "#75b5dc",
    mint: "#85c8aa",
    rose: "#c77b80",
    amber: "#d6ad72",
    line: "#31404b",
    faint: "#7b8a94",
    white: "#e4e8ea",
  };
  const loopDuration = 16000;
  const stageDuration = loopDuration / stages.length;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let elapsed = 0;
  let lastTimestamp = 0;
  let currentStage = 0;
  let animationFrame;
  let transitionTimer;
  let isRunning = false;
  let isVisible = true;
  let pausedByUser = false;

  function pointOnCurve(points, progress) {
    const [start, controlOne, controlTwo, end] = points;
    const inverse = 1 - progress;
    return [
      inverse ** 3 * start[0] +
        3 * inverse ** 2 * progress * controlOne[0] +
        3 * inverse * progress ** 2 * controlTwo[0] +
        progress ** 3 * end[0],
      inverse ** 3 * start[1] +
        3 * inverse ** 2 * progress * controlOne[1] +
        3 * inverse * progress ** 2 * controlTwo[1] +
        progress ** 3 * end[1],
    ];
  }

  function ease(progress) {
    return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
  }

  function drawCurve(points, color, lineWidth, alpha = 1, dash = []) {
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.setLineDash(dash);
    context.beginPath();
    context.moveTo(...points[0]);
    context.bezierCurveTo(...points.slice(1).flat());
    context.stroke();
    context.restore();
  }

  function drawOrb(x, y, radius, color, glow = 0, alpha = 1) {
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = glow;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawLabel(text, x, y, color) {
    context.fillStyle = color;
    context.font = "11px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.fillText(text, x, y);
  }

  function drawEndpoint(x, y, state, label) {
    const color =
      state === "failed"
        ? colors.rose
        : state === "selected"
          ? colors.mint
          : state === "trial"
            ? colors.amber
            : colors.faint;
    const alpha = state === "idle" ? 0.38 : 1;
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 16, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(x, y, 9, 0, Math.PI * 2);
    context.stroke();
    if (state === "failed") {
      context.beginPath();
      context.moveTo(x - 7, y - 7);
      context.lineTo(x + 7, y + 7);
      context.moveTo(x + 7, y - 7);
      context.lineTo(x - 7, y + 7);
      context.stroke();
    }
    if (state === "selected") drawOrb(x, y, 4, color, 15);
    if (state === "trial") {
      context.beginPath();
      context.moveTo(x, y - 7);
      context.lineTo(x + 7, y);
      context.lineTo(x, y + 7);
      context.lineTo(x - 7, y);
      context.closePath();
      context.stroke();
    }
    context.restore();
    drawLabel(label, x, y + 39, color);
  }

  function drawStarfield() {
    for (let index = 0; index < 24; index += 1) {
      drawOrb((index * 89) % width, (index * 47) % height, 1, colors.blue, 0, 0.13);
    }
  }

  function applyStage(stage, immediate = false) {
    if (stage === currentStage && !immediate) return;
    window.clearTimeout(transitionTimer);
    const update = () => {
      currentStage = stage;
      stageLabel.textContent = stages[stage].label;
      stageDetail.textContent = stages[stage].detail;
      caption.classList.remove("bridge-s0", "bridge-s1", "bridge-s2", "bridge-s3");
      caption.classList.add(`bridge-s${stage}`);
      caption.classList.remove("is-transitioning");
    };
    if (immediate || reducedMotionQuery.matches) {
      update();
      return;
    }
    caption.classList.add("is-transitioning");
    transitionTimer = window.setTimeout(update, 180);
  }

  function drawScene() {
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    const phase = elapsed % loopDuration;
    const stage = Math.min(stages.length - 1, Math.floor(phase / stageDuration));
    const stageProgress = (phase - stage * stageDuration) / stageDuration;
    const fadeIn = Math.min(1, stageProgress / 0.18);
    const fadeOut = Math.min(1, (1 - stageProgress) / 0.18);
    const travelerAlpha = Math.min(fadeIn, fadeOut);
    const travelProgress = Math.min(1, stageProgress / 0.58);
    const compact = width < 420;
    const points = {
      start: [width * (compact ? 0.17 : 0.1), height * 0.56],
      hub: [width * (compact ? 0.4 : 0.39), height * 0.56],
      failed: [width * (compact ? 0.78 : 0.84), height * 0.18],
      selected: [width * (compact ? 0.78 : 0.84), height * 0.58],
    };
    const paths = {
      incoming: [
        points.start,
        [width * 0.18, height * 0.56],
        [width * 0.3, height * 0.56],
        points.hub,
      ],
      failed: [
        points.hub,
        [width * 0.5, height * 0.44],
        [width * 0.64, height * 0.1],
        points.failed,
      ],
      selected: [
        points.hub,
        [width * 0.55, height * 0.66],
        [width * 0.66, height * 0.76],
        points.selected,
      ],
    };

    applyStage(stage);
    drawStarfield();
    drawCurve(paths.incoming, colors.line, 8, 0.55);
    drawCurve(
      paths.failed,
      stage === 3 && stageProgress < 0.62 ? colors.amber : colors.rose,
      1.6,
      stage === 3 && stageProgress < 0.62 ? 0.85 : 0.45,
      stage === 3 && stageProgress < 0.62 ? [4, 6] : [],
    );
    drawCurve(paths.selected, colors.blue, 8, 0.12);
    drawCurve(paths.selected, colors.mint, 1.6, 0.32);
    drawEndpoint(
      ...points.failed,
      stage === 3 && stageProgress < 0.62 ? "trial" : "failed",
      stage === 3 && stageProgress < 0.62 ? "half-open trial" : "failed model",
    );
    drawEndpoint(...points.selected, stage >= 2 ? "selected" : "idle", "selected model");
    drawLabel("new request", points.start[0], points.start[1] + 34, colors.blue);
    drawLabel("Bifrost", points.hub[0], points.hub[1] - 19, colors.blue);
    drawOrb(...points.start, 7, colors.blue, 20);
    drawOrb(...points.hub, 4, colors.blue, 12, stage > 0 ? 1 : 0.28);

    if (stage === 0) {
      const traveler = pointOnCurve(paths.incoming, ease(travelProgress));
      drawCurve(paths.incoming, colors.blue, 2.2, 0.9);
      drawOrb(...traveler, 5, colors.white, 18, travelerAlpha);
    } else if (stage === 1) {
      const pulse = 0.5 + 0.35 * Math.sin(stageProgress * Math.PI * 3);
      drawCurve(paths.incoming, colors.blue, 2.2, 0.9);
      drawCurve(paths.failed, colors.rose, 1.8 + pulse * 1.2, pulse * 0.8 + 0.2);
      drawOrb(...points.hub, 5, colors.white, 18);
      drawOrb(
        ...points.failed,
        6,
        colors.rose,
        8,
        0.4 + 0.4 * Math.sin(stageProgress * Math.PI * 2.5 - 0.5),
      );
    } else if (stage === 2) {
      const traveler = pointOnCurve(paths.selected, ease(travelProgress));
      drawCurve(paths.incoming, colors.blue, 2.2, 0.9);
      drawCurve(paths.selected, colors.blue, 10, 0.24);
      drawCurve(paths.selected, colors.mint, 2.3, 0.95);
      drawOrb(...traveler, 5, colors.white, 19, travelerAlpha);
    } else {
      const arrivalEnd = 0.2;
      const usesIncomingPath = stageProgress < arrivalEnd;
      const progress = usesIncomingPath
        ? stageProgress / arrivalEnd
        : Math.min(1, (stageProgress - arrivalEnd) / (1 - arrivalEnd) / 0.5);
      const path = usesIncomingPath ? paths.incoming : paths.failed;
      const traveler = pointOnCurve(path, ease(progress));
      drawCurve(paths.incoming, colors.blue, usesIncomingPath ? 2.2 : 1.2, usesIncomingPath ? 0.7 : 0.38);
      drawCurve(paths.selected, colors.mint, 1.6, 0.35);
      drawCurve(paths.failed, colors.amber, 1.5, 0.85, [4, 6]);
      drawOrb(...traveler, 5, colors.amber, 18, travelerAlpha);
    }
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.round(bounds.width);
    const nextHeight = Math.round(bounds.height);
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (
      nextWidth === width &&
      nextHeight === height &&
      nextPixelRatio === pixelRatio
    ) return;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = nextPixelRatio;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawScene();
  }

  function stop() {
    if (!isRunning) return;
    window.cancelAnimationFrame(animationFrame);
    isRunning = false;
    lastTimestamp = 0;
  }

  function start() {
    if (
      isRunning ||
      pausedByUser ||
      reducedMotionQuery.matches ||
      !isVisible ||
      document.hidden
    ) return;
    isRunning = true;
    const animate = (timestamp) => {
      if (!isRunning) return;
      if (lastTimestamp) elapsed += timestamp - lastTimestamp;
      lastTimestamp = timestamp;
      drawScene();
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
  }

  function syncAnimation() {
    stop();
    if (reducedMotionQuery.matches) {
      elapsed = loopDuration * 0.62;
      applyStage(2, true);
      drawScene();
      return;
    }
    drawScene();
    start();
  }

  toggle.addEventListener("click", () => {
    pausedByUser = !pausedByUser;
    toggleLabel.textContent = pausedByUser ? "Play" : "Pause";
    toggle.setAttribute(
      "aria-label",
      `${pausedByUser ? "Play" : "Pause"} reliability animation`,
    );
    toggle.dataset.paused = String(pausedByUser);
    syncAnimation();
  });

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry.isIntersecting;
      syncAnimation();
    },
    { rootMargin: "200px 0px" },
  );
  visibilityObserver.observe(canvas);

  document.addEventListener("visibilitychange", syncAnimation);
  reducedMotionQuery.addEventListener("change", syncAnimation);
  resize();
  applyStage(0, true);
  syncAnimation();
}

if (bridgeCanvas) setupBridgeAnimation(bridgeCanvas);

const copyStatus = document.querySelector("#copy-status");
const copyButtons = document.querySelectorAll(".copy-button");

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy command was unavailable");
}

function copyValue(button) {
  if (button.dataset.copy) return button.dataset.copy;
  const target = document.getElementById(button.dataset.copyTarget ?? "");
  return target?.textContent ?? "";
}

function announceCopyStatus(message) {
  if (!copyStatus) return;
  copyStatus.textContent = "";
  window.requestAnimationFrame(() => {
    copyStatus.textContent = message;
  });
}

function resetCopyButton(button, label) {
  window.setTimeout(() => {
    button.childNodes[0].textContent = label;
    delete button.dataset.copied;
  }, 1800);
}

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const originalLabel = button.childNodes[0]?.textContent ?? "Copy";
    try {
      await copyText(copyValue(button));
      button.childNodes[0].textContent = "Copied";
      button.dataset.copied = "true";
      announceCopyStatus("Copied to clipboard");
      resetCopyButton(button, originalLabel);
    } catch {
      announceCopyStatus("Copy failed. Select the code and copy it manually.");
      button.childNodes[0].textContent = "Copy failed";
      resetCopyButton(button, originalLabel);
    }
  });
}
