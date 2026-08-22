// Falling gold coins background. Attaches a canvas to every element with the
// .coin-rain class. Skipped entirely when the user prefers reduced motion.
(function () {
  "use strict";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  document.querySelectorAll(".coin-rain").forEach(attach);

  function attach(host) {
    const canvas = document.createElement("canvas");
    canvas.className = "coin-rain-canvas";
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);
    const ctx = canvas.getContext("2d");

    let width = 0;
    let height = 0;
    let coins = [];

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = host.clientWidth;
      height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = Math.max(10, Math.min(30, Math.round(width / 46)));
      while (coins.length < target) coins.push(newCoin(true));
      coins.length = target;
    }

    function newCoin(anywhere) {
      const r = 6 + Math.random() * 9;
      return {
        x: Math.random() * width,
        y: anywhere ? Math.random() * height : -r * 2,
        r,
        vy: 26 + Math.random() * 46,          // fall speed, px/s
        phase: Math.random() * Math.PI * 2,   // spin
        spin: 1.2 + Math.random() * 2.4,      // spin speed, rad/s
        swayAmp: 6 + Math.random() * 14,
        swayFreq: 0.4 + Math.random() * 0.8,
        t: Math.random() * 10,
        alpha: 0.45 + Math.random() * 0.4,
      };
    }

    function drawCoin(c) {
      const sway = Math.sin(c.t * c.swayFreq * Math.PI * 2) * c.swayAmp;
      const squish = Math.abs(Math.cos(c.phase)) * 0.88 + 0.12;

      ctx.save();
      ctx.globalAlpha = c.alpha;
      ctx.translate(c.x + sway, c.y);
      ctx.rotate(Math.sin(c.phase) * 0.25);
      ctx.scale(squish, 1);

      const g = ctx.createRadialGradient(-c.r * 0.35, -c.r * 0.35, c.r * 0.15, 0, 0, c.r);
      g.addColorStop(0, "#f7e6a6");
      g.addColorStop(0.55, "#d9b45c");
      g.addColorStop(1, "#8a6d24");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, c.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(90, 70, 20, 0.75)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // inner rim
      ctx.beginPath();
      ctx.arc(0, 0, c.r * 0.68, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 92, 30, 0.55)";
      ctx.stroke();

      ctx.restore();
    }

    let last = performance.now();
    function frame(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        c.y += c.vy * dt;
        c.phase += c.spin * dt;
        c.t += dt;
        if (c.y - c.r * 2 > height) coins[i] = newCoin(false);
        drawCoin(coins[i]);
      }
      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(frame);
  }
})();
