const gatewayCanvas = document.querySelector("#gateway-canvas");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupGatewayAnimation(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const routes = [];
  let animationFrame;
  let isRunning = false;
  let isVisible = false;
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
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
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
    if (isRunning || document.hidden || !isVisible) return;
    if (reducedMotionQuery.matches) {
      draw(0);
      return;
    }
    isRunning = true;
    const animate = (timestamp) => {
      if (!isRunning) return;
      if (reducedMotionQuery.matches) {
        stop();
        draw(0);
        return;
      }
      draw(timestamp);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    isVisible = entry.isIntersecting;
    if (isVisible) start();
    else stop();
  }, { threshold: 0.05 }).observe(canvas);
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

const autoCanvas = document.querySelector("#auto-canvas");

function setupAutoAnimation(canvas) {
  const context = canvas.getContext("2d");
  const stageLabel = document.querySelector("#auto-stage-label");
  const stageDetail = document.querySelector("#auto-stage-detail");
  const toggle = document.querySelector("#auto-toggle");
  const toggleLabel = document.querySelector("#auto-toggle-label");

  if (!context || !stageLabel || !stageDetail || !toggle || !toggleLabel) return;

  const stages = [
    {
      label: "01 · Select bifrost/auto",
      detail: "Auto starts only when you select it in Pi's model picker.",
    },
    {
      label: "02 · Resolve the user turn",
      detail: "Bifrost resolves a tier and filters your configured pool before selection.",
    },
    {
      label: "03 · Dispatch a physical model",
      detail: "Pi runs the chosen provider/model and records which physical model answered.",
    },
    {
      label: "04 · Continue on the same model",
      detail: "Tool continuations stay on the turn's model. Auto can make one alternate attempt after Pi proves all allowance failures were empty and omitted.",
    },
  ];
  const colors = {
    blue: "#75b5dc",
    mint: "#85c8aa",
    line: "#31404b",
    faint: "#a6b0b8",
    white: "#e4e8ea",
  };
  const loopDuration = 16000;
  const stageDuration = loopDuration / stages.length;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let elapsed = 0;
  let lastTimestamp = 0;
  let currentStage = -1;
  let animationFrame;
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

  function drawNode(point, label, active, compact) {
    const color = active ? colors.mint : colors.blue;
    context.strokeStyle = color;
    context.globalAlpha = active ? 1 : 0.55;
    context.lineWidth = active ? 1.8 : 1;
    context.beginPath();
    context.arc(...point, 13, 0, Math.PI * 2);
    context.stroke();
    if (active) drawOrb(...point, 3, colors.mint, 10);
    context.globalAlpha = 1;
    context.fillStyle = active ? colors.white : colors.faint;
    context.font = "11px SFMono-Regular, Consolas, monospace";
    context.textAlign = compact ? "left" : "center";
    context.fillText(label, point[0] + (compact ? 25 : 0), point[1] + (compact ? 4 : 38));
  }

  function pathBetween(start, end, compact) {
    if (compact) {
      return [start, [start[0] - 12, start[1] + 24], [end[0] - 12, end[1] - 24], end];
    }
    const distance = end[0] - start[0];
    return [start, [start[0] + distance * 0.4, start[1] - 18], [end[0] - distance * 0.4, end[1] + 18], end];
  }

  function applyStage(stage) {
    if (stage === currentStage) return;
    currentStage = stage;
    stageLabel.textContent = stages[stage].label;
    stageDetail.textContent = stages[stage].detail;
  }

  function drawScene() {
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    const phase = elapsed % loopDuration;
    const stage = Math.min(stages.length - 1, Math.floor(phase / stageDuration));
    const progress = (phase - stage * stageDuration) / stageDuration;
    const compact = width < 520;
    const points = compact
      ? [0.14, 0.38, 0.62, 0.86].map((y) => [width * 0.16, height * y])
      : [0.11, 0.37, 0.65, 0.89].map((x) => [width * x, height * 0.45]);
    const paths = [0, 1, 2].map((index) => pathBetween(points[index], points[index + 1], compact));
    const continuation = [
      points[3],
      compact ? [width * 0.72, points[3][1]] : [width * 0.9, height * 0.1],
      compact ? [width * 0.72, points[2][1]] : [width * 0.62, height * 0.1],
      points[2],
    ];

    applyStage(stage);
    paths.forEach((path, index) => {
      drawCurve(path, colors.line, 6, 0.55);
      drawCurve(path, index < stage ? colors.mint : colors.blue, 1.5, index < stage ? 0.8 : 0.35);
    });
    drawCurve(continuation, colors.blue, 1.2, stage === 3 ? 0.8 : 0.2, [4, 7]);
    const labels = ["bifrost/auto", "tier + pool", "provider/model", "Pi turn"];
    const lastActive = stage === 0 ? 0 : stage === 1 ? 1 : stage === 2 && progress < 0.5 ? 2 : 3;
    points.forEach((point, index) => {
      drawNode(point, labels[index], index <= lastActive, compact);
    });

    if (stage > 0) {
      const segment = stage === 1 ? paths[0] : stage === 2
        ? (progress < 0.5 ? paths[1] : paths[2])
        : continuation;
      const travel = stage === 2 ? (progress * 2) % 1 : progress;
      const traveler = pointOnCurve(segment, ease(Math.min(1, travel)));
      const fade = Math.min(1, progress * 8, (1 - progress) * 8);
      drawOrb(...traveler, 4, colors.white, 14, fade);
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
      if (reducedMotionQuery.matches) {
        syncAnimation();
        return;
      }
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
      applyStage(2);
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
      `${pausedByUser ? "Play" : "Pause"} Auto animation`,
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
  applyStage(0);
  syncAnimation();
}

if (autoCanvas) setupAutoAnimation(autoCanvas);

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
