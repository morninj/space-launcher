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

// The palette is re-rolled too: a hue for the ink, and a separate one for the
// water it drifts in. The water only ever takes a faint cast of its hue, dark
// in a dark scheme and pale in a light one, so any pairing still reads as ink
// on a plain ground.
const baseHue = hash2(5, 0) * 360;
const waterHue = hash2(6, 0) * 360;
const waterSaturation = 18 + hash2(7, 0) * 24;

const DROPS = 140; // ink sources alive at once
const PER_DROP = 22; // filaments each one sends out

let w = 0;
let h = 0;
let dpr = 1;
let dark = true;
let filaments = [];
let frame = null;
let time = 0;
let spawned = 0;

// Where the ink piles up. The currents barely move, so filaments funnel onto
// the same few streamlines and comb over them again and again; left alone
// those ribbons go solid and, being additive, wash out to white. A single
// global erase rate cannot see that — the screen as a whole stays moderate
// while those bands burn out. So the canvas is read back, coarsely, and used
// two ways: filaments stop feeding a cell that is already full, and the map
// itself erases in proportion to what is there.
const METER_W = 64;
const METER_H = 36;
const METER_INTERVAL = 12; // frames between readbacks
const CROWD_CAP = 0.42; // cell density at which a filament lays down nothing
const LOCAL_ERASE = 0.006; // per frame, scaled by that cell's own density
const FLAT_ERASE = 0.0012; // the old even nibble, so lone filaments still fade

const meter = document.createElement("canvas");
meter.width = METER_W;
meter.height = METER_H;
const meterCtx = meter.getContext("2d", { willReadFrequently: true });
let density = null;
let sinceMeter = METER_INTERVAL;

// Downscaling to a thumbnail and reading that back is cheap; reading the full
// canvas would not be. Alpha alone says how much ink is down, in either colour
// scheme, since the ink is laid on glass with the haze behind it.
function sampleDensity() {
  if (!w || !h) return;
  meterCtx.clearRect(0, 0, METER_W, METER_H);
  // Blurred at thumbnail scale — a pixel here is some thirty on screen — so
  // neighbouring cells bleed into each other and the map has no seams.
  meterCtx.filter = "blur(1px)";
  meterCtx.drawImage(canvas, 0, 0, METER_W, METER_H);
  meterCtx.filter = "none";
  density = meterCtx.getImageData(0, 0, METER_W, METER_H).data;
}

// Read between the cells, not out of one: a nearest-cell lookup makes the cap
// fall along cell edges, which reads as rectangles cut out of the ink.
function crowding(x, y) {
  if (!density) return 0;
  const fx = Math.min(METER_W - 1, Math.max(0, (x / w) * METER_W - 0.5));
  const fy = Math.min(METER_H - 1, Math.max(0, (y / h) * METER_H - 0.5));
  const ix = fx | 0;
  const iy = fy | 0;
  const tx = fx - ix;
  const ty = fy - iy;
  const jx = Math.min(METER_W - 1, ix + 1);
  const jy = Math.min(METER_H - 1, iy + 1);
  const at = (cx, cy) => density[(cy * METER_W + cx) * 4 + 3];
  const top = at(ix, iy) * (1 - tx) + at(jx, iy) * tx;
  const bottom = at(ix, jy) * (1 - tx) + at(jx, jy) * tx;
  return (top * (1 - ty) + bottom * ty) / 255;
}

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
  if (sinceMeter++ >= METER_INTERVAL) {
    sinceMeter = 0;
    sampleDensity();
  }

  // Two erases, both subtracting alpha rather than laying down background, so
  // the haze keeps showing through. The first is the old even nibble: at this
  // rate a lone filament stays legible for well over a minute. The second is
  // the density map painted back over the canvas, which takes away in
  // proportion to what each part of the glass is already holding — heavy on a
  // silted ribbon, next to nothing on open water. Upscaling the thumbnail
  // blurs it, so it lifts a region rather than cutting at the lines in it.
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = FLAT_ERASE;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (density) {
    ctx.globalAlpha = LOCAL_ERASE;
    ctx.drawImage(meter, 0, 0, w, h);
  }

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

    // The one that matters: ink thins out as the water around it fills, and
    // stops at the cap. The filament still travels — it just stops thickening
    // a ribbon that is already solid. Eased at both ends so the ink fades out
    // of a crowd rather than stopping on a line.
    const t = Math.min(1, crowding(f.x, f.y) / CROWD_CAP);
    const room = 1 - t * t * (3 - 2 * t);
    if (room <= 0) continue;

    ctx.strokeStyle = f.ink;
    ctx.lineWidth = f.width * (0.35 + 0.65 * taper);
    ctx.globalAlpha =
      (dark ? 0.019 : 0.017) * (0.14 + 0.86 * falloff) * taper * f.weight * room;
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
  if (!w) return; // nothing has been sized yet, so there is nothing to paint
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(step);
}

function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = null;
}

// Priming is hundreds of frames of ink; done in one go it holds up the first
// paint, and the list is what someone is actually waiting for. So it runs in
// small batches across the first few frames instead, with a token so a resize
// mid-batch abandons the old one rather than racing it.
let generation = 0;

function prime(token, frames) {
  if (token !== generation) return;
  const batch = Math.min(20, frames);
  for (let i = 0; i < batch; i++) advance();
  const left = frames - batch;
  if (left > 0) {
    // Held in `frame` like any other, so stopping the art stops this too.
    frame = requestAnimationFrame(() => prime(token, left));
  } else {
    frame = null;
    if (!reduced.matches) start();
  }
}

function resize() {
  w = window.innerWidth;
  h = window.innerHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = haze.width = w * dpr;
  canvas.height = haze.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.style.background = `hsl(${waterHue} ${waterSaturation}% ${dark ? 5 : 95}%)`;

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);

  filaments = [];
  spawned = 0;
  stop();
  density = null;
  sinceMeter = METER_INTERVAL;

  // The haze is one heavy pass and the priming is many; neither is worth
  // holding the list behind, so both wait for the frame after it is up.
  const token = ++generation;
  requestAnimationFrame(() => {
    if (token !== generation) return;
    drawHaze();
    // Open with the water already threaded, then keep growing from there. The
    // priming frames meter themselves, so the opening cannot silt up either.
    prime(token, 170);
  });
}

// Nothing is painted into the copy Chrome is about to throw away.
unlessReplaced(() => {
  resize();
  window.addEventListener("resize", resize);
});

// Don't paint into a tab nobody is looking at.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else if (!reduced.matches) start();
});
