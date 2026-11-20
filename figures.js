// Inline figures for the write-up. Both reuse the machine's maths: the same
// banding + dot screen as the comic shader, and the same string simulation.
import { createString } from './string.js';

const DPR = Math.min(window.devicePixelRatio, 2);
const RGB = {
  bg: [8, 13, 26],
  ink: [13, 20, 38],
  cream: [240, 234, 210],
  gold: '#f0c06a',
  goldDeep: '#e2ad55',
};

// Run `tick` every frame only while `el` is on screen.
function whileVisible(el, tick) {
  let on = false;
  let raf = 0;
  let last = 0;
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    tick(dt);
    if (on) raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(([e]) => {
    on = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (on) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }).observe(el);
}

const PAPER = [31, 42, 70];

/* ============================================================
 * Figure 2: halftone-shaded sphere
 * ========================================================== */
function halftoneFigure() {
  const cv = document.getElementById('fig-halftone');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const lightIn = document.getElementById('fig-ht-light');
  const dotIn = document.getElementById('fig-ht-dot');
  const inkIn = document.getElementById('fig-ht-ink');
  const lightOut = document.getElementById('fig-ht-light-out');
  const dotOut = document.getElementById('fig-ht-dot-out');

  // Zoom and pan, as a magnifier over the printed page: `k` is the zoom and
  // (cx, cy) the point of the figure at the centre of the view, as fractions
  // of its width. The sphere is redrawn at every zoom, so the dots stay sharp.
  const view = { k: 1, cx: 0.5, cy: 0.5 };
  const K_MAX = 8;
  const resetBtn = cv.parentElement.querySelector('.fig-zoom-reset');

  // Mid-gesture (a pinch, a pan, a trackpad zoom) the figure is drawn at half
  // resolution, a quarter of the pixels, so it keeps up on slower phones; it
  // is redrawn sharp a moment after the gesture stops.
  let gesturing = false;
  let settle = 0;
  const busy = () => {
    gesturing = true;
    clearTimeout(settle);
    settle = setTimeout(() => {
      gesturing = false;
      redraw();
    }, 150);
  };

  function draw() {
    const scale = DPR * (gesturing ? 0.5 : 1);
    const size = Math.max(1, Math.round(cv.clientWidth * scale));
    if (cv.width !== size) cv.width = cv.height = size;
    const img = ctx.createImageData(size, size);
    const d = img.data;

    // Same view-space light as the machine, swung around the vertical axis.
    const a = (+lightIn.value * Math.PI) / 180;
    let lx = -0.45 * Math.cos(a) + 0.52 * Math.sin(a);
    let ly = 0.72;
    let lz = 0.45 * Math.sin(a) + 0.52 * Math.cos(a);
    const ln = Math.hypot(lx, ly, lz);
    lx /= ln; ly /= ln; lz /= ln;

    const dot = +dotIn.value * scale;
    const ink = inkIn.checked;
    const R = size * 0.38;
    const line = 2.6 * scale;
    const c = size / 2;
    const screen = (px, py, r) => {
      // 45° screen-space grid, as in print
      const u = (0.7071 * px - 0.7071 * py) / dot;
      const v = (0.7071 * px + 0.7071 * py) / dot;
      const fu = u - Math.floor(u) - 0.5;
      const fv = v - Math.floor(v) - 0.5;
      return fu * fu + fv * fv <= r * r;
    };

    const zk = view.k;
    const ox = view.cx * size - size / 2 / zk;
    const oy = view.cy * size - size / 2 / zk;
    for (let y = 0; y < size; y++) {
      const py = oy + (y + 0.5) / zk;
      for (let x = 0; x < size; x++) {
        const px = ox + (x + 0.5) / zk;
        const dx = (px - c) / R, dy = (py - c) / R;
        const r2 = dx * dx + dy * dy;
        let col = PAPER; // lighter than the page so the ink outline reads
        let k = 1;
        if (r2 <= 1) {
          const nz = Math.sqrt(1 - r2);
          const l = dx * lx - dy * ly + nz * lz;
          col = RGB.cream;
          if (l < 0.3) {
            const r = 0.2 + 0.16 * Math.min(1, Math.max(0, (0.3 - l) / 0.42));
            if (screen(px, py, r)) k = 0.7;
          }
          if (l < -0.12) {
            if (screen(px, py, 0.38)) col = RGB.ink;
            else k = 0.78;
          }
        } else if (ink && Math.sqrt(r2) * R <= R + line) {
          col = RGB.ink;
        }
        const i = (y * size + x) * 4;
        d[i] = col[0] * (col === RGB.ink ? 1 : k);
        d[i + 1] = col[1] * (col === RGB.ink ? 1 : k);
        d[i + 2] = col[2] * (col === RGB.ink ? 1 : k);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    lightOut.textContent = `${(+lightIn.value).toString().replace('-', '−')}°`;
    dotOut.textContent = `${dotIn.value} px`;
  }

  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  };
  [lightIn, dotIn, inkIn].forEach((el) => el.addEventListener('input', redraw));
  new ResizeObserver(redraw).observe(cv);

  /* ---------- pinch, drag and double-tap to zoom ---------- */
  const clampView = () => {
    view.k = Math.min(K_MAX, Math.max(1, view.k));
    const m = 0.5 / view.k;
    view.cx = Math.min(1 - m, Math.max(m, view.cx));
    view.cy = Math.min(1 - m, Math.max(m, view.cy));
    // Zoomed in, one finger pans the figure; zoomed out, it scrolls the page.
    const zoomed = view.k > 1.001;
    cv.classList.toggle('zoomed', zoomed);
    if (resetBtn) resetBtn.hidden = !zoomed;
    redraw();
  };
  // Screen point, as fractions of the canvas, relative to its centre.
  const frac = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width - 0.5, y: (e.clientY - r.top) / r.height - 0.5 };
  };
  // Zoom by `f`, keeping the figure point under screen point `s` in place.
  const zoomAt = (s, f) => {
    const k = Math.min(K_MAX, Math.max(1, view.k * f));
    view.cx += s.x / view.k - s.x / k;
    view.cy += s.y / view.k - s.y / k;
    view.k = k;
    clampView();
  };
  const resetView = () => {
    Object.assign(view, { k: 1, cx: 0.5, cy: 0.5 });
    clampView();
  };
  const panBy = (dx, dy) => {
    view.cx -= dx / view.k;
    view.cy -= dy / view.k;
    clampView();
  };

  const pts = new Map(); // pointerId -> last screen point
  let lastTap = null;
  let moved = false;
  const pair = () => {
    const [a, b] = [...pts.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    pts.set(e.pointerId, frac(e));
    moved = pts.size > 1;
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  });
  cv.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const before = pts.size === 2 ? pair() : null;
    const p = frac(e);
    pts.set(e.pointerId, p);
    if (before) {
      busy();
      const after = pair();
      if (before.dist > 0) zoomAt(after.mid, after.dist / before.dist);
      panBy(after.mid.x - before.mid.x, after.mid.y - before.mid.y);
    } else if (pts.size === 1 && view.k > 1.001) {
      busy();
      panBy(p.x - prev.x, p.y - prev.y);
    }
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.002) moved = true;
  });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (e.type !== 'pointerup' || moved || pts.size) return;
    // Double-tap (or double-click) toggles between zoomed in and out.
    const s = frac(e), now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(s.x - lastTap.s.x, s.y - lastTap.s.y) < 0.06) {
      if (view.k > 1.001) resetView();
      else zoomAt(s, 3);
      lastTap = null;
    } else lastTap = { s, t: now };
  };
  cv.addEventListener('pointerup', lift);
  cv.addEventListener('pointercancel', lift);
  // A trackpad pinch arrives as a ctrl+wheel; a plain wheel still scrolls the page.
  cv.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    busy();
    zoomAt(frac(e), Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  // Safari's own pinch gesture would zoom the whole page.
  cv.addEventListener('gesturestart', (e) => e.preventDefault());

  // Keyboard: + and − zoom on the centre, 0 resets, arrows pan while zoomed.
  cv.tabIndex = 0;
  cv.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const centre = { x: 0, y: 0 };
    const pan = { ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0], ArrowUp: [0, 0.12], ArrowDown: [0, -0.12] }[e.key];
    if (e.key === '+' || e.key === '=') zoomAt(centre, 1.5);
    else if (e.key === '-' || e.key === '_') zoomAt(centre, 1 / 1.5);
    else if (e.key === '0') resetView();
    else if (pan && view.k > 1.001) panBy(...pan);
    else return; // anything else (and arrows when not zoomed) does what it normally does
    e.preventDefault();
  });
  resetBtn?.addEventListener('click', () => {
    resetView();
    cv.focus();
  });
}

/* ============================================================
 * Figure 3: the brush string, flattened
 * ========================================================== */
function stringFigure() {
  const cv = document.getElementById('fig-string');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const N = 47;
  const str = createString(N, { c2: 900, spring: 3, max: 0.42 });
  const dampIn = document.getElementById('fig-str-damp');
  const dampOut = document.getElementById('fig-str-damp-out');
  const driveIn = document.getElementById('fig-str-drive');
  // The drive starts on, so the string moves by itself; not for readers who
  // have asked their device for less motion.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) driveIn.checked = false;
  let phase = 0;
  let drive = 0; // eased 0..1 so toggling doesn't jolt the string

  const geom = () => {
    const W = cv.width, H = cv.height;
    const pad = 22 * DPR;
    return {
      W, H,
      x: (i) => pad + (i / (N - 1)) * (W - pad * 2),
      y: (u) => H / 2 - (u / 0.3) * (H / 2 - 16 * DPR),
      u: (py) => ((H / 2 - py) / (H / 2 - 16 * DPR)) * 0.3,
    };
  };

  function resize() {
    cv.width = Math.max(1, Math.round(cv.clientWidth * DPR));
    cv.height = Math.max(1, Math.round(cv.clientHeight * DPR));
  }
  new ResizeObserver(resize).observe(cv);
  resize();

  function draw() {
    const g = geom();
    ctx.fillStyle = `rgb(${RGB.bg})`;
    ctx.fillRect(0, 0, g.W, g.H);
    // rest line
    ctx.setLineDash([5 * DPR, 4 * DPR]);
    ctx.strokeStyle = 'rgba(240, 234, 210, 0.15)';
    ctx.lineWidth = 1 * DPR;
    ctx.beginPath();
    ctx.moveTo(g.x(0), g.y(0));
    ctx.lineTo(g.x(N - 1), g.y(0));
    ctx.stroke();
    ctx.setLineDash([]);
    // driven end
    if (drive > 0.01) {
      ctx.fillStyle = RGB.goldDeep;
      ctx.beginPath();
      ctx.arc(g.x(0) - 12 * DPR, g.y(str.dL), 3.5 * DPR, 0, Math.PI * 2);
      ctx.fill();
    }
    // string
    ctx.strokeStyle = RGB.gold;
    ctx.lineWidth = 2 * DPR;
    ctx.shadowColor = 'rgba(255, 190, 90, 0.6)';
    ctx.shadowBlur = 6 * DPR;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = g.x(i), y = g.y(str.u[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // beads
    for (let i = 0; i < N; i++) {
      const held = i === str.held;
      ctx.fillStyle = held ? RGB.gold : `rgb(${RGB.cream})`;
      ctx.strokeStyle = `rgb(${RGB.ink})`;
      ctx.lineWidth = 2 * DPR;
      ctx.beginPath();
      ctx.arc(g.x(i), g.y(str.u[i]), (held ? 6 : 4) * DPR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  whileVisible(cv, (dt) => {
    const damp = 0.08 + +dampIn.value * 3.2;
    drive += ((driveIn.checked ? 1 : 0) - drive) * Math.min(1, dt * 3);
    const steps = Math.ceil(dt * 240);
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      phase += h * Math.PI * 2 * 1.2;
      str.dL = Math.sin(phase) * 0.09 * drive;
      str.step(h, damp);
    }
    draw();
  });

  dampIn.addEventListener('input', () => (dampOut.textContent = (+dampIn.value).toFixed(2)));
  document.getElementById('fig-str-pluck').addEventListener('click', () => str.pluck(Math.floor(N / 2), 5));

  // drag a bead; a tap plucks it
  let grab = null;
  const toCanvas = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * DPR, y: (e.clientY - r.top) * DPR };
  };
  cv.addEventListener('pointerdown', (e) => {
    const p = toCanvas(e);
    const g = geom();
    const i = Math.max(0, Math.min(N - 1, Math.round(((p.x - g.x(0)) / (g.x(N - 1) - g.x(0))) * (N - 1))));
    grab = { i, x: e.clientX, y: e.clientY, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!grab) return;
    if (!grab.moved && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 4) return;
    grab.moved = true;
    str.held = grab.i;
    str.heldU = Math.max(-str.max, Math.min(str.max, geom().u(toCanvas(e).y)));
  });
  const end = () => {
    if (!grab) return;
    if (!grab.moved) str.pluck(grab.i, 5);
    str.held = -1;
    grab = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

halftoneFigure();
stringFigure();
