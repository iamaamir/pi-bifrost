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
