// Ink dropped into a slow current: clusters of filaments grow through a noise
// field, comb past each other, and taper out. What they draw stays put; a
// near-invisible wash keeps the canvas from silting up over a long session.
const seed = (Math.random() * 0xffffffff) >>> 0;

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

// Value noise: hashed lattice with a smoothstep between corners.
function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function hueOf(hex) {
  const [r, g, b] = channels(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}


const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");
const haze = document.getElementById("haze");
const hazeCtx = haze.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// Re-rolled per load: curl tightness, palette width, how hard the field turns,
// and how slowly the currents themselves reshape.
const scale = 0.0011 + hash2(1, 0) * 0.002;
const spread = 50 + hash2(2, 0) * 110;
const turns = 2 + hash2(3, 0) * 3;
const churn = 0.00004 + hash2(4, 0) * 0.00007;

const DROPS = 140; // ink sources alive at once
const PER_DROP = 22; // filaments each one sends out

let w = 0;
let h = 0;
let dpr = 1;
let dark = true;
let baseHue = 140;
let filaments = [];
let frame = null;
let time = 0;
let spawned = 0;

// A still underlay, drawn once: the same currents at a whisper, so the empty
// parts of the screen are never actually empty.
function drawHaze() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  hazeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hazeCtx.clearRect(0, 0, w, h);
  hazeCtx.globalCompositeOperation = dark ? "lighter" : "multiply";
  hazeCtx.lineCap = "round";

  const center = { x: w / 2, y: h / 2 };
  const reach = Math.min(w, h) * 0.38;
  const base = dark ? 0.008 : 0.007;
  const passes = [
    { count: 2800, steps: 110, pace: 6, width: [0.25, 0.9], alpha: 1 },
    { count: 4400, steps: 16, pace: 3, width: [0.12, 0.34], alpha: 1.4 },
  ];

  passes.forEach((pass, layer) => {
    for (let i = 0; i < pass.count; i++) {
      const key = layer * 7717 + i + 50000;
      let x = hash2(key, 11) * w;
      let y = hash2(key, 23) * h;

      const tint = noise2(x * scale * 2, y * scale * 2);
      const rogue = hash2(key, 71) > 0.96 ? 110 : 0;
      const hue = baseHue + (tint - 0.5) * spread + rogue;
      hazeCtx.strokeStyle = `hsl(${hue} ${18 + hash2(key, 83) * 16}% ${
        dark ? 34 + tint * 8 : 40 + tint * 8
      }%)`;
      const [min, max] = pass.width;
      hazeCtx.lineWidth = min + hash2(key, 37) * (max - min);

      hazeCtx.beginPath();
      hazeCtx.moveTo(x, y);
      for (let step = 0; step < pass.steps; step++) {
        const angle =
          (noise2(x * scale, y * scale) * 0.72 +
            noise2(x * scale * 2.7, y * scale * 2.7) * 0.28) *
          Math.PI *
          turns;
        x += Math.cos(angle) * pass.pace;
        y += Math.sin(angle) * pass.pace;
        if (x < -50 || x > w + 50 || y < -50 || y > h + 50) break;
        hazeCtx.lineTo(x, y);
      }
      // Gentler falloff than the ink: this layer's job is to fill.
      const falloff = Math.min(1, Math.hypot(x - center.x, y - center.y) / reach);
      hazeCtx.globalAlpha = base * pass.alpha * (0.3 + 0.7 * falloff);
      hazeCtx.stroke();
    }
  });
}

// A drop: a cluster of filaments released from one point, sharing an ink.
function drop() {
  const id = spawned++;
  const cx = hash2(id, 101) * w;
  const cy = hash2(id, 211) * h;
  const radius = 24 + hash2(id, 307) * 95;
  const tint = noise2(cx * scale * 2, cy * scale * 2);
  const rogue = hash2(id, 71) > 0.93 ? 110 : 0;
  const hue = baseHue + (tint - 0.5) * spread + rogue;
  const saturation = 22 + hash2(id, 83) * 18;
  const light = dark ? 36 + tint * 8 : 40 + tint * 8;

  return Array.from({ length: PER_DROP }, (_, i) => {
    const key = id * 31 + i;
    const angle = hash2(key, 7) * Math.PI * 2;
    // Three samples averaged: dense at the middle, sparse and soft at the rim.
    const bell = (hash2(key, 17) + hash2(key, 19) + hash2(key, 23)) / 3;
    const reach = radius * bell * 1.6;
    return {
      x: cx + Math.cos(angle) * reach,
      y: cy + Math.sin(angle) * reach,
      px: cx,
      py: cy,
      ink: `hsl(${hue} ${saturation}% ${light}%)`,
      width: 0.22 + hash2(key, 37) * 1.15,
      age: 0,
      // Long lives: a filament should have time to cross open space.
      span: 1900 + hash2(key, 53) * 3600,
      pace: 0.7 + hash2(key, 67) * 0.9,
      // Its own bias through the field, so siblings diverge instead of
      // travelling as a solid ribbon with an edge.
      curl: (hash2(key, 89) - 0.5) * 0.5,
      // Rim filaments carry less ink than the ones from the middle.
      weight: 0.25 + (1 - bell) * 0.95,
    };
  });
}

function advance() {
  // A barely-there erase keeps the canvas from silting up over long sessions;
  // at this rate a filament stays legible for well over a minute. It subtracts
  // alpha instead of laying down background, so the haze shows through.
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 0.0012;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = dark ? "lighter" : "multiply";
  ctx.lineCap = "round";

  const cx = w / 2;
  const cy = h / 2;
  const reach = Math.min(w, h) * 0.3;

  for (let i = filaments.length - 1; i >= 0; i--) {
    const f = filaments[i];
    // Two octaves, the first sampled at a creeping offset so the currents
    // reshape while the filaments are still growing through them.
    const angle =
      (noise2(f.x * scale + time, f.y * scale) * 0.72 +
        noise2(f.x * scale * 2.7, f.y * scale * 2.7 + time) * 0.28) *
        Math.PI *
        turns +
      f.curl;

    f.px = f.x;
    f.py = f.y;
    f.x += Math.cos(angle) * f.pace;
    f.y += Math.sin(angle) * f.pace;
    f.age++;

    if (f.age > f.span || f.x < -60 || f.x > w + 60 || f.y < -60 || f.y > h + 60) {
      filaments.splice(i, 1);
      continue;
    }

    // Tapers as it runs out, the way a drawn-out thread of ink thins.
    const life = f.age / f.span;
    const taper = Math.min(1, (1 - life) * 3) * Math.min(1, f.age / 25);
    const falloff = Math.min(1, Math.hypot(f.x - cx, f.y - cy) / reach);

    ctx.strokeStyle = f.ink;
    ctx.lineWidth = f.width * (0.35 + 0.65 * taper);
    ctx.globalAlpha =
      (dark ? 0.019 : 0.017) * (0.14 + 0.86 * falloff) * taper * f.weight;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(f.x, f.y);
    ctx.stroke();
  }

  // Keep the water seeded as filaments expire.
  while (filaments.length < DROPS * PER_DROP) filaments.push(...drop());

  time += churn;
}

function step() {
  advance();
  frame = requestAnimationFrame(step);
}

function start() {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(step);
}

function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = null;
}

function resize() {
  w = window.innerWidth;
  h = window.innerHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = haze.width = w * dpr;
  canvas.height = haze.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const style = getComputedStyle(document.documentElement);
  dark = matchMedia("(prefers-color-scheme: dark)").matches;
  baseHue = hueOf(style.getPropertyValue("--accent").trim());

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);

  drawHaze();
  filaments = [];
  spawned = 0;
  stop();
  // Open with the water already threaded, then keep growing from there.
  for (let i = 0; i < 170; i++) advance();
  if (!reduced.matches) start();
}

resize();
window.addEventListener("resize", resize);
// Don't paint into a tab nobody is looking at.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else if (!reduced.matches) start();
});
