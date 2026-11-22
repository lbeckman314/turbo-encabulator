import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { animate, createTimeline, stagger } from 'animejs';
import { createString } from './string.js';

// Palette values are written straight to the screen (no linear conversion),
// so the flat comic colors come out exactly as specified.
THREE.ColorManagement.enabled = false;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DPR = Math.min(window.devicePixelRatio, 2);

const PAL = {
  bg: 0x0b1222,
  ink: 0x0d1426,
  cream: 0xf0ead2,
  paper: 0xe2dac2,
  gray: 0xaeb1b5,
  warm: 0xb8b0a0,
  slate: 0x2b2f3f,
  gold: 0xe2ad55,
  hi: 0xffbe5a,
  red: 0xc8553d,
  teal: 0x4f8f8a,
  shadow: 0x1a2440,
  copper: 0xc77b45,
};

/* ============================================================
 * Renderer, scene, camera
 * ========================================================== */
const hero = document.getElementById('hero');
const canvas = document.getElementById('scene');
const heroSize = () => ({ w: hero.clientWidth, h: hero.clientHeight });
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(DPR);
renderer.setClearColor(PAL.bg);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 32;
controls.maxPolarAngle = Math.PI * 0.62;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.45;
// No panning: it would slide the machine off the spot it's fitted to. Two
// fingers pinch to zoom (and twist to turn) instead.
controls.enablePan = false;
controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
controls.addEventListener('start', () => (controls.autoRotate = false));

const isNarrow = () => window.innerWidth < 720;
const CAM_DIR = new THREE.Vector3(-0.58, 0.3, 0.76).normalize();
// The part of the hero the machine should sit in, in hero pixels: clear of
// the title and the control card. `at` can describe the card as it will be
// (collapsed, top edge in client px) so we can head there while it animates.
function freeRect(at = {}) {
  const { w, h } = heroSize();
  const hb = hero.getBoundingClientRect();
  const rect = hero.querySelector('.card').getBoundingClientRect();
  const card = { top: at.cardTop ?? rect.top, right: rect.right };
  const collapsed = at.collapsed ?? hero.classList.contains('focus');
  // always below the big title
  const r = { x0: 0, y0: document.getElementById('title').getBoundingClientRect().bottom - hb.top, x1: w, y1: h };
  let pad = 40;
  if (isNarrow()) {
    // phones: card along the bottom (collapsed or not)
    pad = 14;
    r.y1 = card.top - hb.top;
  } else if (collapsed) {
    // wide, collapsed: just the card's top row, bottom left
    r.y1 = card.top - hb.top;
  } else {
    // wide: card on the left
    r.x0 = card.right - hb.left;
  }
  return { x0: r.x0 + pad, y0: r.y0 + pad, x1: r.x1 - pad, y1: r.y1 - pad };
}

// Rough half-extents of the assembled machine as seen from CAM_DIR. Wide
// screens get a closer camera, so more perspective: the base's front corner
// reaches further down.
const FIT_W = 3.0;
const fitH = () => (isNarrow() ? 2.6 : 3.05);
const camHome = (at) => {
  const { w, h } = heroSize();
  const aspect = w / h;
  camera.fov = aspect < 0.8 ? 48 : 35;
  camera.updateProjectionMatrix();
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Distance at which the machine fits the free rect (1 world unit spans
  // h / (2 · dist · halfH) pixels).
  const f = freeRect(at);
  const fw = Math.max(80, f.x1 - f.x0), fh = Math.max(80, f.y1 - f.y0);
  const dist = Math.max(7, (FIT_W * h) / (halfH * fw), (fitH() * h) / (halfH * fh));
  const target = new THREE.Vector3(0, -0.45, 0);
  return { target, pos: target.clone().addScaledVector(CAM_DIR, dist), dist, f };
};
{
  const { target, pos } = camHome();
  controls.target.copy(target);
  camera.position.copy(pos);
}

/* ---------- starfield ---------- */
{
  const N = 1600;
  const pts = new Float32Array(N * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    v.randomDirection().multiplyScalar(45 + Math.random() * 40);
    pts.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: PAL.cream, size: 1.4 * DPR, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false,
  })));
}

/* ============================================================
 * Comic shading
 *  - fill: flat palette color; mid-tones get a 45° halftone of a darker
 *    shade, deep shadow gets ink dots. Light is fixed in view space so
 *    the shading reads like a drawing as you orbit.
 *  - outline: inverted hull pushed out by a constant number of pixels
 *    along smoothed normals, drawn in ink (gold when hovered).
 *  - dissolve: parts fade in/out through the halftone screen.
 * ========================================================== */
const U = {
  uInk: { value: new THREE.Color(PAL.ink) },
  uHi: { value: new THREE.Color(PAL.hi) },
  uLight: { value: new THREE.Vector3(-0.45, 0.72, 0.52).normalize() },
  uDot: { value: 4.4 * DPR },
  uLine: { value: 1.35 * DPR },
  uView: { value: new THREE.Vector2(1, 1) },
};

const GLSL_SCREEN = /* glsl */ `
  uniform float uDot;
  vec2 screenCell() {
    vec2 p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * gl_FragCoord.xy / uDot;
    return fract(p) - 0.5;
  }
  float screen(float r) { return step(length(screenCell()), r); }
  void dissolve(float fade) {
    if (fade <= 0.0) return;
    if (length(screenCell()) * 1.4142 > 1.0 - fade * 1.05) discard;
  }
`;
const GLSL_INSTANCE = /* glsl */ `
  vec3 pos = position;
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    pos = (instanceMatrix * vec4(pos, 1.0)).xyz;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
`;

function fillMaterial(color, fx) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uBase: { value: new THREE.Color(color) },
      uGlow: { value: 0 },
      uFade: fx.fade,
      uHover: fx.hover,
    },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      void main() {
        ${GLSL_INSTANCE}
        vN = normalize(normalMatrix * nrm);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uInk, uHi, uLight;
      uniform float uGlow, uFade, uHover;
      varying vec3 vN;
      ${GLSL_SCREEN}
      void main() {
        dissolve(uFade);
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        float l = dot(n, uLight);
        vec3 c = uBase;
        if (l < 0.3) {
          float r = mix(0.2, 0.36, clamp((0.3 - l) / 0.42, 0.0, 1.0));
          c = mix(uBase, uBase * 0.7, screen(r));
        }
        if (l < -0.12) c = mix(uBase * 0.78, uInk, screen(0.38));
        c = mix(c, min(uBase * 1.35 + 0.12, vec3(1.0)), uGlow);
        c = mix(c, uHi, uHover * 0.32);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function outlineMaterial(fx) {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uFade: fx.fade, uHover: fx.hover },
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      attribute vec3 outNormal;
      uniform float uLine, uHover;
      uniform vec2 uView;
      void main() {
        ${GLSL_INSTANCE}
        vec3 on = outNormal;
        #ifdef USE_INSTANCING
          on = mat3(instanceMatrix) * on;
        #endif
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        vec4 nc = projectionMatrix * modelViewMatrix * vec4(pos + on * 0.01, 1.0);
        vec2 d = (nc.xy / nc.w - clip.xy / clip.w) * uView;
        float len = length(d);
        if (len > 1e-6) clip.xy += (d / len) * uLine * (1.0 + uHover * 0.9) * 2.0 / uView * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk, uHi;
      uniform float uFade, uHover;
      ${GLSL_SCREEN}
      void main() {
        dissolve(uFade);
        gl_FragColor = vec4(mix(uInk, uHi, uHover), 1.0);
      }`,
  });
}

// Average normals of coincident vertices so hard edges don't crack the hull.
function addOutlineNormals(geo) {
  if (geo.attributes.outNormal) return;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const key = (i) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const sums = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const s = sums.get(k) || sums.set(k, new THREE.Vector3()).get(k);
    s.x += nrm.getX(i);
    s.y += nrm.getY(i);
    s.z += nrm.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.copy(sums.get(key(i)));
    if (v.lengthSq() < 1e-8) v.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    v.normalize();
    out.set([v.x, v.y, v.z], i * 3);
  }
  geo.setAttribute('outNormal', new THREE.BufferAttribute(out, 3));
}

/* ============================================================
 * Parts registry
 * Each part is built at its assembled position: home is (0,0,0) and the
 * exploded position is just its `explode` vector.
 * ========================================================== */
const machine = new THREE.Group();
scene.add(machine);
const parts = [];
const partById = {};
const pickables = [];
const flatMats = []; // canvas-textured planes that fade with their part

function part(id, name, info, explode, anchor) {
  const group = new THREE.Group();
  machine.add(group);
  const p = {
    id, name, info, group,
    explode: new THREE.Vector3(...explode),
    anchor: new THREE.Vector3(...anchor),
    fx: { fade: { value: 0 }, hover: { value: 0 } },
  };
  parts.push(p);
  partById[id] = p;
  return p;
}

/**
 * Make a mesh. `look` is either a palette color (shaded with the comic
 * material at finalize time) or a ready material (kept as is, no outline).
 */
const PLACEHOLDER = new THREE.MeshBasicMaterial();
function mesh(geo, look, { position, rotation, unique = false, outline = true } = {}) {
  const isColor = typeof look === 'number';
  const m = new THREE.Mesh(geo, isColor ? PLACEHOLDER : look);
  m.userData.color = isColor ? look : null;
  m.userData.unique = unique;
  m.userData.outline = isColor && outline;
  if (position) m.position.copy(position);
  if (rotation) m.rotation.copy(rotation);
  return m;
}
const alongX = (m) => ((m.rotation.z = Math.PI / 2), m);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const E = (x, y, z) => new THREE.Euler(x, y, z);

const FLOOR_Y = -2.245;

/* ---------- Prefabulated Amulite baseplate ---------- */
const base = part(
  'base',
  'Prefabulated Amulite baseplate',
  'The original machine had a [[base plate of pre-famulated amulite]] surmounted by a malleable logarithmic casing…',
  [0, -1.1, 0],
  [2.25, -1.62, 0.6]
);
{
  const zf = (x) => 1.05 + 0.42 * Math.sin(x * 1.25); // S-curved front edge
  const W = 2.1;
  const shape = new THREE.Shape();
  const xs = Array.from({ length: 61 }, (_, i) => -2.7 + (5.4 * i) / 60);
  // Shape Y maps to world -Z after the -90° X rotation below.
  shape.moveTo(xs[0], -zf(xs[0]));
  xs.forEach((x) => shape.lineTo(x, -zf(x)));
  [...xs].reverse().forEach((x) => shape.lineTo(x, -(zf(x) - W)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.46, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 3, curveSegments: 24,
  });
  base.group.add(mesh(geo, PAL.paper, { position: V(0, -2.2, 0), rotation: E(-Math.PI / 2, 0, 0) }));

  // Halftone drop shadow on the "floor" (travels with the baseplate).
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 6),
    new THREE.ShaderMaterial({
      uniforms: { ...U, uColor: { value: new THREE.Color(PAL.shadow) }, uFade: base.fx.fade },
      transparent: true,
      depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uFade; varying vec2 vUv;
        ${GLSL_SCREEN}
        void main() {
          dissolve(uFade);
          vec2 p = (vUv - 0.5) * vec2(9.0, 6.0);
          float e = length(p / vec2(3.4, 1.9));
          float r = 0.46 * (1.0 - smoothstep(0.35, 1.0, e));
          if (screen(r) < 0.5) discard;
          gl_FragColor = vec4(uColor, 1.0);
        }`,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = FLOOR_Y;
  shadow.renderOrder = -1;
  shadow.userData.noPick = true;
  base.group.add(shadow);
}

/* ---------- Spurving bearing posts ---------- */
const posts = part(
  'posts',
  'Spurving bearing posts',
  '…in such a way that the two [[spurving bearings]] were in a direct line with the panametric fan.',
  [0, -0.55, 0],
  [-1.1, -1.35, 0.1]
);
for (const x of [-1.1, 1.1]) {
  posts.group.add(mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.8, 20), PAL.gray, { position: V(x, -1.32, 0) }));
  posts.group.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 28), PAL.gold, { position: V(x, -0.93, 0) }));
  posts.group.add(mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.03, 28), PAL.gray, { position: V(x, -1.685, 0) }));
}

/* ---------- Malleable logarithmic casing ---------- */
const casing = part(
  'casing',
  'Malleable logarithmic casing',
  '…a base plate of pre-famulated amulite surmounted by a [[malleable logarithmic casing]] in such a way that the two spurving bearings were in a direct line with the panametric fan.',
  [0, 0, 0],
  [-1.85, 0.72, 0.62]
);
// A slice of drum along x, between angles t0 and t0 + tl. Angles run around
// the axis from the front (+z, t = 0) up over the top (+y, t = π/2).
const drum = (r, x0, x1, t0, tl, color, opts = {}) => alongX(mesh(
  new THREE.CylinderGeometry(r, r, x1 - x0, Math.max(8, Math.round((96 * tl) / (Math.PI * 2))), 1, true, t0, tl),
  color, { position: V((x0 + x1) / 2, 0, 0), ...opts },
));
const TAU = Math.PI * 2;
// The hatch: a window over the front-top of the drum, closed by a panel that
// comes away in the exploded view (a cutaway, as in technical comics).
const CUT = { x0: -1.8, x1: 1.8, t0: 0.15, t1: 1.3 };
const LINER = 0.975; // inside face of the drum wall
{
  const { x0, x1, t0, t1 } = CUT;
  // outer wall, with the window left open
  casing.group.add(drum(1, -2.1, x0, 0, TAU, PAL.cream));
  casing.group.add(drum(1, x0, x1, t1, TAU - (t1 - t0), PAL.cream));
  casing.group.add(drum(1, x1, 2.1, 0, TAU, PAL.cream));
  // dark lining, so the inside reads as a deep drum rather than more casing
  casing.group.add(drum(LINER, -2.1, x0, 0, TAU, PAL.slate, { outline: false }));
  casing.group.add(drum(LINER, x0, x1, t1, TAU - (t1 - t0), PAL.slate, { outline: false }));
  casing.group.add(drum(LINER, x1, 2.1, 0, TAU, PAL.slate, { outline: false }));
  // stiffening hoops inside
  for (const x of [-1.45, -0.6, 0.25, 1.1]) {
    casing.group.add(mesh(new THREE.TorusGeometry(0.955, 0.022, 8, 96), PAL.gray, { position: V(x, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
  }
  // window frame: the cut edges of the wall, inked
  for (const x of [x0, x1]) {
    casing.group.add(mesh(new THREE.TorusGeometry(0.99, 0.022, 8, 40, t1 - t0), PAL.gray, { position: V(x, 0, 0), rotation: E(-t0, -Math.PI / 2, 0) }));
  }
  for (const t of [t0, t1]) {
    casing.group.add(alongX(mesh(new THREE.CylinderGeometry(0.022, 0.022, x1 - x0, 8), PAL.gray, { position: V(0, 0.99 * Math.sin(t), 0.99 * Math.cos(t)) })));
  }
  // end caps: cream outside, dark inside
  casing.group.add(mesh(new THREE.CircleGeometry(1, 96), PAL.cream, { position: V(2.1, 0, 0), rotation: E(0, Math.PI / 2, 0), outline: false }));
  casing.group.add(mesh(new THREE.CircleGeometry(LINER, 96), PAL.slate, { position: V(2.08, 0, 0), rotation: E(0, -Math.PI / 2, 0), outline: false }));
  casing.group.add(mesh(new THREE.TorusGeometry(1.0, 0.03, 10, 96), PAL.gray, { position: V(2.1, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
}
// The hatch rides on its own group with its own dissolve, so in the exploded
// view it can lift a little and fade away through the dot screen (anything
// flying further would cover the brushes and pipes lifting above it).
const hatch = new THREE.Group();
casing.group.add(hatch);
const hatchState = { open: 0 }; // 0 closed .. 1 gone
const hatchFx = { fade: { value: 0 }, hover: casing.fx.hover };
{
  const { x0, x1, t0, t1 } = CUT;
  // ready-made materials (bound to hatchFx), so finalize leaves them alone
  const inked = (m) => {
    addOutlineNormals(m.geometry);
    const hull = new THREE.Mesh(m.geometry, outlineMaterial(hatchFx));
    hull.raycast = () => {};
    m.add(hull);
    return m;
  };
  hatch.add(inked(drum(1, x0, x1, t0, t1 - t0, fillMaterial(PAL.cream, hatchFx))));
  hatch.add(drum(LINER, x0, x1, t0, t1 - t0, fillMaterial(PAL.slate, hatchFx)));
  // gold rivets at the corners
  const rivet = new THREE.SphereGeometry(0.035, 12, 8);
  const gold = fillMaterial(PAL.gold, hatchFx);
  for (const x of [x0 + 0.09, x1 - 0.09]) {
    for (const t of [t0 + 0.07, t1 - 0.07]) {
      hatch.add(inked(mesh(rivet, gold, { position: V(x, 1.005 * Math.sin(t), 1.005 * Math.cos(t)) })));
    }
  }
}
const tm = (CUT.t0 + CUT.t1) / 2;
const HATCH_OUT = V(0, Math.sin(tm), Math.cos(tm)).multiplyScalar(0.45); // lifts along its own normal

/* ---------- Lotus-o-delta main winding (inside the casing) ---------- */
const winding = part(
  'winding',
  'Lotus-o-delta main winding',
  '…it is produced by the [[modial interaction of magneto-reluctance and capacitive diractance]]. … The [[main winding]] was of the normal lotus-o-delta type…',
  [0, 0, 0],
  [-0.75, 0.5, 0.2]
);
const windRot = new THREE.Group(); // turns with the fan, so the gold turns crawl along like a barber pole
winding.group.add(windRot);
const windingMeshes = { copper: null, gold: null };
{
  // the ambifacient lunar waneshaft, running the length of the drum
  winding.group.add(alongX(mesh(new THREE.CylinderGeometry(0.055, 0.055, 4.1, 14), PAL.gray)));
  const X0 = -1.55, X1 = 0.95, TURNS = 21, R = 0.44;
  windRot.add(alongX(mesh(new THREE.CylinderGeometry(0.33, 0.33, X1 - X0 + 0.1, 40), PAL.slate, { position: V((X0 + X1) / 2, 0, 0) })));
  const pitch = (X1 - X0) / TURNS;
  class Turn extends THREE.Curve {
    constructor(x) { super(); this.x = x; }
    getPoint(t, out = new THREE.Vector3()) {
      return out.set(this.x + pitch * t, R * Math.sin(t * TAU), R * Math.cos(t * TAU));
    }
  }
  for (let k = 0; k < TURNS; k++) {
    const gold = k % 7 === 3;
    // unique material per colour group, so the glow can be driven separately
    const m = mesh(new THREE.TubeGeometry(new Turn(X0 + k * pitch), 40, 0.04, 8, false), gold ? PAL.gold : PAL.copper);
    windRot.add(m);
    if (gold) windingMeshes.gold ??= m;
    else windingMeshes.copper ??= m;
  }
  // collector rings at both ends of the core
  for (const x of [X0 - 0.08, X1 + 0.08]) {
    windRot.add(mesh(new THREE.TorusGeometry(0.34, 0.035, 10, 48), PAL.gold, { position: V(x, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
  }
}

/* ---------- Differential girdle spring (inside the casing) ---------- */
const spring = part(
  'spring',
  'Differential girdle spring',
  '…every seventh conductor being connected by a non-reversible tremie pipe to the [[differential girdle spring]] on the “up” end of the grammeters.',
  [0, 0, 0],
  [1.45, 0.72, -0.05]
);
const springRot = new THREE.Group();
springRot.position.x = 1.45;
spring.group.add(springRot);
{
  const TURNS = 4.5, R0 = 0.12, R1 = 0.7;
  class Spiral extends THREE.Curve {
    getPoint(t, out = new THREE.Vector3()) {
      const a = t * TURNS * TAU, r = R0 + (R1 - R0) * t;
      return out.set(0.04 * Math.sin(a * 0.5), r * Math.sin(a), r * Math.cos(a));
    }
  }
  springRot.add(mesh(new THREE.TubeGeometry(new Spiral(), 220, 0.024, 6, false), PAL.gold));
  springRot.add(alongX(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 24), PAL.gray)));
  spring.group.add(mesh(new THREE.TorusGeometry(0.76, 0.03, 8, 72), PAL.gray, { position: V(1.45, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
}

/* ---------- Panandermic semi-boloid stator slots ---------- */
const stator = part(
  'stator',
  'Panandermic semi-boloid stator slots',
  'The main winding was of the normal lotus-o-delta type placed in [[panendermic semi-boloid slots]] of the stator…',
  [-0.95, 0, 0],
  [-2.15, -0.95, 0.4]
);
{
  stator.group.add(mesh(new THREE.TorusGeometry(1.0, 0.075, 14, 96), PAL.gold, { position: V(-2.1, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
  stator.group.add(mesh(new THREE.TorusGeometry(0.64, 0.03, 10, 72), PAL.gray, { position: V(-2.12, 0, 0), rotation: E(0, Math.PI / 2, 0) }));
  const N = 30;
  const slots = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.075, 0.34, 16), PLACEHOLDER, N);
  slots.userData = { color: PAL.gray, outline: true };
  const d = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    d.position.set(-2.12, Math.cos(a) * 0.83, Math.sin(a) * 0.83);
    d.rotation.set(0, 0, Math.PI / 2);
    d.updateMatrix();
    slots.setMatrixAt(i, d.matrix);
  }
  stator.group.add(slots);
}

/* ---------- Pentametric fan ---------- */
const fan = part(
  'fan',
  'Pentametric fan',
  '…in a direct line with the [[panametric fan]]. The latter consisted simply of six [[hydrocoptic marzlevanes]]…',
  [-1.9, 0, 0],
  [-2.5, 0.9, 0.2]
);
const rotor = new THREE.Group();
rotor.position.x = -2.42;
fan.group.add(rotor);
{
  fan.group.add(alongX(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 14), PAL.gray, { position: V(-2.2, 0, 0) })));
  rotor.add(alongX(mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.18, 28), PAL.gold)));
  rotor.add(mesh(new THREE.SphereGeometry(0.13, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), PAL.gold, {
    position: V(-0.09, 0, 0), rotation: E(0, 0, Math.PI / 2),
  }));
  const bladeGeo = new THREE.SphereGeometry(1, 28, 14);
  for (let k = 0; k < 6; k++) {
    const pivot = new THREE.Group();
    pivot.rotation.x = (k / 6) * Math.PI * 2;
    const blade = mesh(bladeGeo, PAL.cream);
    blade.scale.set(0.025, 0.36, 0.14);
    blade.position.y = 0.42;
    blade.rotation.y = 0.55;
    pivot.add(blade);
    rotor.add(pivot);
  }
}

/* ---------- Ambifacient wane shaft ---------- */
const shaft = part(
  'shaft',
  'Ambifacient wane shaft',
  '…six hydrocoptic marzlevanes, so fitted to the [[ambifacient lunar waneshaft]] that side fumbling was effectively prevented.',
  [1.05, 0, 0],
  [2.55, 0.3, 0]
);
shaft.group.add(alongX(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.42, 18), PAL.gray, { position: V(2.3, 0, 0) })));
shaft.group.add(alongX(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 28), PAL.gold, { position: V(2.14, 0, 0) })));
shaft.group.add(mesh(new THREE.SphereGeometry(0.075, 20, 14), PAL.gray, { position: V(2.52, 0, 0) }));

/* ---------- Panel meters ---------- */
const panel = part(
  'panel',
  'Panel meters',
  '…a transmission that would not only supply [[inverse reactive current]] for use in unilateral phase detractors, but would also be capable of automatically synchronizing [[cardinal grammeters]].',
  [0, 0, 1.15],
  [1.05, 0.62, 1.05]
);

const CSS = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
function makeMeter(label, unit) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 440;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { c, ctx: c.getContext('2d'), tex, label, unit, last: -1 };
}
function drawMeter(m, v) {
  v = THREE.MathUtils.clamp(v, 0, 1.04);
  if (Math.abs(v - m.last) < 0.0008) return;
  m.last = v;
  const { ctx } = m;
  const W = 512, H = 440;
  const ink = CSS(PAL.ink);
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CSS(PAL.cream);
  ctx.beginPath();
  ctx.roundRect(14, 14, W - 28, H - 28, 18);
  ctx.fill();
  const cx = W / 2, cy = H * 0.8, R = 186;
  const a0 = Math.PI * 1.18, a1 = Math.PI * 1.82;
  ctx.lineCap = 'round';
  ctx.strokeStyle = CSS(PAL.gold);
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(cx, cy, R - 10, a0 + (a1 - a0) * 0.78, a1);
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, R, a0, a1);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 20; i++) {
    const a = a0 + ((a1 - a0) * i) / 20;
    const major = i % 5 === 0;
    const len = major ? 30 : 14;
    ctx.lineWidth = major ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
    ctx.stroke();
    if (major) {
      ctx.font = '600 24px "Martian Mono", monospace';
      ctx.fillText(String(i * 5), cx + Math.cos(a) * (R + 32), cy + Math.sin(a) * (R + 32) + 9);
    }
  }
  ctx.font = '400 20px "Martian Mono", monospace';
  ctx.fillStyle = CSS(PAL.slate);
  ctx.fillText(m.unit, cx, cy - 74);
  ctx.font = '800 32px "Archivo", sans-serif';
  ctx.fillStyle = ink;
  ctx.fillText(m.label, cx, H - 40);
  const a = a0 + (a1 - a0) * v;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * 24, cy - Math.sin(a) * 24);
  ctx.lineTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18));
  ctx.stroke();
  ctx.fillStyle = CSS(PAL.gold);
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.stroke();
  m.tex.needsUpdate = true;
}

const meters = [makeMeter('INRUSH', 'AMPS ×10'), makeMeter('REALIZATION', 'PERCENT')];
const buttonMeshes = [];
{
  const g = new THREE.Group();
  g.position.set(1.05, 0.02, 0.97);
  panel.group.add(g);
  g.add(mesh(new RoundedBoxGeometry(1.55, 0.78, 0.14, 3, 0.04), PAL.warm));
  meters.forEach((m, j) => {
    const x = -0.1 + j * 0.58;
    g.add(mesh(new RoundedBoxGeometry(0.52, 0.46, 0.05, 2, 0.02), PAL.slate, { position: V(x, 0, 0.085) }));
    const mat = new THREE.MeshBasicMaterial({ map: m.tex, transparent: true });
    flatMats.push({ mat, fx: panel.fx });
    g.add(mesh(new THREE.PlaneGeometry(0.47, 0.404), mat, { position: V(x, 0, 0.112) }));
    drawMeter(m, 0);
  });
  [PAL.red, PAL.gold, PAL.teal].forEach((color, k) => {
    const y = 0.2 - k * 0.2;
    const b = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 20), color, { position: V(-0.58, y, 0.09), rotation: E(Math.PI / 2, 0, 0), unique: true });
    buttonMeshes.push(b);
    g.add(b);
    g.add(mesh(new THREE.TorusGeometry(0.056, 0.012, 8, 28), PAL.gray, { position: V(-0.58, y, 0.075) }));
  });
}

/* ---------- Nameplate ---------- */
const badge = part(
  'badge',
  'Nameplate',
  '',
  [0, 0, 0.8],
  [-0.75, -0.18, 1.05]
);
const badgeCanvas = document.createElement('canvas');
badgeCanvas.width = 1024;
badgeCanvas.height = 96;
const badgeTex = new THREE.CanvasTexture(badgeCanvas);
badgeTex.colorSpace = THREE.SRGBColorSpace;
badgeTex.anisotropy = 4;
function drawBadge() {
  const ctx = badgeCanvas.getContext('2d');
  const W = 1024, H = 96;
  ctx.fillStyle = CSS(PAL.slate);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CSS(PAL.cream);
  ctx.font = '800 42px "Archivo", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '9px';
  ctx.textAlign = 'right';
  ctx.fillText('TURBO', W / 2 - 66, H / 2 + 2);
  ctx.textAlign = 'left';
  ctx.fillText('ENCABULATOR', W / 2 + 66, H / 2 + 2);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = CSS(PAL.gold);
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = CSS(PAL.ink);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = W / 2 - 25 + (50 * i) / 60;
    const y = H / 2 + Math.sin((i / 60) * Math.PI * 2) * 13;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  badgeTex.needsUpdate = true;
}
drawBadge();
badge.group.add(mesh(new RoundedBoxGeometry(1.5, 0.16, 0.03, 2, 0.012), PAL.gray, { position: V(-0.75, 0.05, 1.0) }));
{
  const mat = new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true });
  flatMats.push({ mat, fx: badge.fx });
  badge.group.add(mesh(new THREE.PlaneGeometry(1.44, 0.135), mat, { position: V(-0.75, 0.05, 1.0161) }));
}

/* ---------- Differential tremie pipes (manifold) ---------- */
const rail = part(
  'rail',
  'Differential tremie pipes',
  '…every seventh conductor being connected by a [[non-reversible tremie pipe]] to the differential girdle spring…',
  [0, 1.35, 0],
  [1.6, 1.45, 0]
);
rail.group.add(alongX(mesh(new THREE.CylinderGeometry(0.028, 0.028, 4.0, 12), PAL.gray, { position: V(0, 1.264, 0) })));
for (const x of [-2, 2]) rail.group.add(mesh(new THREE.SphereGeometry(0.036, 14, 10), PAL.gold, { position: V(x, 1.264, 0) }));
rail.group.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.2, 10), PAL.gray, { position: V(-2, 1.36, 0) }));
rail.group.add(mesh(new THREE.TorusGeometry(0.05, 0.012, 8, 24), PAL.gold, { position: V(-2, 1.46, 0), rotation: E(Math.PI / 2, 0, 0) }));

/* ---------- 47 manestically spaced grouting brushes ---------- */
const brushes = part(
  'brushes',
  'Grouting brushes ×47',
  '',
  [0, 0, 0],
  [-1.15, 1.42, 0.12]
);
const brushItems = [];
{
  const N = 47;
  const archGeo = new THREE.TorusGeometry(0.085, 0.011, 6, 20, Math.PI);
  const legGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.17, 6);
  const tuftGeo = new THREE.CylinderGeometry(0.028, 0.044, 0.08, 10);
  for (let i = 0; i < N; i++) {
    const item = new THREE.Group();
    item.position.x = -1.84 + (i * 3.68) / (N - 1);
    item.add(mesh(archGeo, PAL.gray, { position: V(0, 1.14, 0), rotation: E(0, Math.PI / 2, 0) }));
    for (const z of [-0.085, 0.085]) item.add(mesh(legGeo, PAL.gray, { position: V(0, 1.055, z), outline: false }));
    const tuft = mesh(tuftGeo, PAL.gold, { position: V(0, 1.02, 0), unique: true });
    item.add(tuft);
    brushes.group.add(item);
    brushItems.push({ item, tuft, state: { lift: 0 } });
  }
}
const brushStates = brushItems.map((b) => b.state);

/* ---------- Phase Inverter (only fitted for Cosinusoidal operation) ---------- */
const inverter = part(
  'inverter',
  'Phase Inverter',
  '',
  [0, -0.35, 0.95],
  [1.55, -0.75, 1.0]
);
{
  // Strapped to the casing below the panel, tilted to sit on the curve.
  const tilt = Math.atan2(0.62, 0.785);
  const g = new THREE.Group();
  g.position.set(1.55, -0.62 * 1.08, 0.785 * 1.08);
  g.rotation.x = tilt;
  inverter.group.add(g);
  g.add(mesh(new RoundedBoxGeometry(0.56, 0.26, 0.18, 2, 0.03), PAL.slate));
  g.add(mesh(new RoundedBoxGeometry(0.08, 0.27, 0.19, 2, 0.02), PAL.gold, { position: V(-0.19, 0, 0) }));
  g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16), PAL.teal, { position: V(0.17, 0, 0.1), rotation: E(Math.PI / 2, 0, 0) }));
  g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16), PAL.gold, { position: V(0.06, 0, 0.1), rotation: E(Math.PI / 2, 0, 0) }));
  // cable up to the panel
  g.add(mesh(new THREE.TorusGeometry(0.16, 0.012, 6, 20, Math.PI), PAL.gray, { position: V(-0.42, 0.04, 0), rotation: E(0, 0, Math.PI / 2) }));
}
inverter.group.scale.setScalar(0.001);
inverter.group.visible = false;

/* ---------- finalize: comic materials, ink outlines, picking ---------- */
for (const p of parts) {
  const cache = new Map();
  const outlineMat = outlineMaterial(p.fx);
  const meshes = [];
  p.group.traverse((o) => o.isMesh && meshes.push(o));
  for (const m of meshes) {
    if (m.userData.noPick) continue;
    m.userData.part = p.id;
    pickables.push(m);
    const color = m.userData.color;
    if (color == null) continue;
    let mat = !m.userData.unique && cache.get(color);
    if (!mat) {
      mat = fillMaterial(color, p.fx);
      if (!m.userData.unique) cache.set(color, mat);
    }
    m.material = mat;
    if (!m.userData.outline) continue;
    addOutlineNormals(m.geometry);
    const hull = m.isInstancedMesh ? new THREE.InstancedMesh(m.geometry, outlineMat, m.count) : new THREE.Mesh(m.geometry, outlineMat);
    if (m.isInstancedMesh) hull.instanceMatrix = m.instanceMatrix;
    hull.raycast = () => {};
    m.add(hull);
  }
}
brushItems.forEach((b) => (b.glow = b.tuft.material.uniforms.uGlow));
const windGlow = { copper: windingMeshes.copper.material.uniforms.uGlow, gold: windingMeshes.gold.material.uniforms.uGlow };
const buttonGlow = buttonMeshes.map((b) => b.material.uniforms.uGlow);

/* ============================================================
 * Machine state (animated by anime.js, read by the render loop)
 * ========================================================== */
const S = {
  rpm: 0, amp: 0, inrush: 0, realization: 0, wave: 'sin', dir: 1, engaged: false, exploded: false,
  inverter: false, garble: 0, spike: 0, blink: 0,
};
const btnStates = buttonGlow.map(() => ({ g: 0 }));

const WAVES = {
  sin: (p) => Math.sin(p),
  cos: (p) => Math.cos(p),
  tan: (p) => THREE.MathUtils.clamp(Math.tan(p * 0.5) * 0.35, -1, 1),
  pip: (p) => Math.pow(Math.max(0, Math.sin(p)), 14) * 1.8 - 0.25,
};

/* ============================================================
 * Brush string: the 47 brushes are masses coupled to their neighbours
 * (a discretized wave equation). One end is driven by the selected wave
 * shape — the fan end, or the shaft end for Cosinusoidal — the other is
 * pinned, so waves travel, reflect and interfere. Brushes can be grabbed.
 * ========================================================== */
const NB = brushItems.length;
const U_MAX = 0.42;
const str = createString(NB, { c2: 900, spring: 3, max: U_MAX }); // ~30 brushes/s
str.phase = 0;
const P = { freq: 1.2, visc: 0.35, blend: 1, prev: 'sin', prevDir: 1 };
const SUBSTEP = 1 / 240;

// An un-inverted Cosine-wave Director comes out garbled.
const garbled = (p) => Math.cos(p + 0.9 * Math.sin(p * 2.3)) * 0.8 + 0.4 * Math.sin(p * 6.1);

function stepString(dt) {
  const steps = Math.ceil(dt / SUBSTEP);
  const h = dt / steps;
  const damp = 0.08 + P.visc * 3.2;
  const fNew = WAVES[S.wave], fOld = WAVES[P.prev];
  for (let s = 0; s < steps; s++) {
    str.phase += h * Math.PI * 2 * P.freq;
    // Cross-fade between the old and new drivers (and ends) after a switch.
    let n = fNew(str.phase);
    if (S.wave === 'cos') n += (garbled(str.phase) - n) * S.garble;
    const wNew = n * P.blend * S.amp * 0.09;
    const wOld = fOld(str.phase) * (1 - P.blend) * S.amp * 0.09;
    str.dL = (S.dir > 0 ? wNew : 0) + (P.prevDir > 0 ? wOld : 0);
    str.dR = (S.dir < 0 ? wNew : 0) + (P.prevDir < 0 ? wOld : 0);
    str.step(h, damp);
  }
}

/* ============================================================
 * Wave-shape consequences, per the datasheet
 *  - Sinusoidal: nominal.
 *  - Cosinusoidal: needs a Phase Inverter; until one is fitted the drive is
 *    garbled, the amber lamp blinks and realization collapses.
 *  - Tangential: every asymptote pegs the inrush meter, rattles the tremie
 *    pipes and flashes the red lamp.
 *  - Pipusoidal: the pentametric fan surges on each pip.
 * ========================================================== */
const SHAPE = {
  sin: { real: 0.874, tone: 'ok', msg: 'Nominal. Realization holding at 87.4%.' },
  cos: { real: 0.874, tone: 'ok', msg: 'Phase Inverter fitted (17.8 millimhos). Nominal.' },
  cosRaw: { real: 0.31, tone: 'warn', msg: 'Cosine-wave Director detected: a Phase Inverter is required.' },
  tan: { real: 0.72, tone: 'warn', msg: 'Tangential asymptotes are pegging the inrush meter.' },
  pip: { real: 0.64, tone: 'info', msg: 'Pipusoidal pulses: the pentametric fan is surging.' },
};
const shapeKey = () => (S.wave === 'cos' && !S.inverter ? 'cosRaw' : S.wave);
// How much of a given shape is currently in effect (follows the cross-fade).
const weight = (name) => (S.wave === name ? P.blend : 0) + (P.prev === name ? 1 - P.blend : 0);

/* ---------- oscilloscope ---------- */
const scope = document.getElementById('scope');
const sctx = scope.getContext('2d');
function sizeScope() {
  const r = scope.getBoundingClientRect();
  scope.width = Math.max(1, Math.round(r.width * DPR));
  scope.height = Math.max(1, Math.round(r.height * DPR));
  sctx.fillStyle = '#080d1a';
  sctx.fillRect(0, 0, scope.width, scope.height);
}
function drawScope() {
  const W = scope.width, H = scope.height;
  const padX = 10 * DPR;
  const sx = (i) => padX + (i / (NB - 1)) * (W - padX * 2);
  const sy = (val) => H / 2 - (val / 0.25) * (H / 2 - 6 * DPR);

  // phosphor persistence: fade the previous frame instead of clearing
  sctx.fillStyle = 'rgba(8, 13, 26, 0.32)';
  sctx.fillRect(0, 0, W, H);

  sctx.strokeStyle = 'rgba(240, 234, 210, 0.05)';
  sctx.lineWidth = 1;
  sctx.beginPath();
  for (let k = 1; k < 8; k++) {
    const x = Math.round((W * k) / 8) + 0.5;
    sctx.moveTo(x, 0);
    sctx.lineTo(x, H);
  }
  for (let k = 1; k < 4; k++) {
    const y = Math.round((H * k) / 4) + 0.5;
    sctx.moveTo(0, y);
    sctx.lineTo(W, y);
  }
  sctx.stroke();

  // driven end(s)
  sctx.fillStyle = '#e2ad55';
  for (const [x, d] of [[padX * 0.4, str.dL], [W - padX * 0.4, str.dR]]) {
    if (Math.abs(d) > 1e-4) {
      sctx.beginPath();
      sctx.arc(x, sy(d), 2.5 * DPR, 0, Math.PI * 2);
      sctx.fill();
    }
  }

  sctx.strokeStyle = '#f0c06a';
  sctx.lineWidth = 2 * DPR;
  sctx.lineJoin = 'round';
  sctx.shadowColor = 'rgba(255, 190, 90, 0.7)';
  sctx.shadowBlur = 6 * DPR;
  sctx.beginPath();
  for (let i = 0; i < NB; i++) {
    const x = sx(i), y = sy(str.u[i]);
    i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
  }
  sctx.stroke();
  sctx.shadowBlur = 0;

  if (str.held >= 0) {
    sctx.strokeStyle = '#ffbe5a';
    sctx.lineWidth = 1.5 * DPR;
    sctx.beginPath();
    sctx.arc(sx(str.held), sy(str.u[str.held]), 5 * DPR, 0, Math.PI * 2);
    sctx.stroke();
  }
}
sizeScope();

/* ============================================================
 * UI
 * ========================================================== */
const $ = (s) => document.querySelector(s);
const engageBtn = $('#engage');
const explodeBtn = $('#explode');
const out = { inrush: $('#r-inrush'), real: $('#r-real'), rpm: $('#r-rpm') };

let engageTl;
function setEngaged(on) {
  finishIntro();
  S.engaged = on;
  engageBtn.classList.toggle('on', on);
  engageBtn.querySelector('.txt').textContent = on ? 'Disengage' : 'Engage';
  engageTl?.pause();
  if (on) {
    controls.autoRotate = false;
    engageTl = createTimeline()
      .add(btnStates, { g: [0, 1], duration: 220, ease: 'outQuad', delay: stagger(160) }, 0)
      .add(S, { inrush: 1, duration: 420, ease: 'outExpo' }, 520)
      .add(S, { inrush: 0.62, duration: 1900, ease: 'outElastic(1, .35)' }, 940)
      .add(S, { rpm: 1, duration: 2800, ease: 'inOutSine' }, 600)
      .add(S, { amp: 1, duration: 1600, ease: 'inOutQuad' }, 1300)
      // read the target when it starts, in case the wave shape changed meanwhile
      .call(() => animate(S, { realization: SHAPE[shapeKey()].real, duration: 3200, ease: 'outQuart' }), 1100);
  } else {
    engageTl = createTimeline()
      .add(S, { amp: 0, rpm: 0, inrush: 0, realization: 0, duration: 2200, ease: 'inOutQuad' }, 0)
      .add(btnStates, { g: 0, duration: 300, ease: 'outQuad', delay: stagger(120, { from: 'last' }) }, 1500);
  }
  updateStatus({ realization: false }); // the timeline above handles it
}

/* ---------- status line + Phase Inverter ---------- */
const statusEl = $('#status');
const statusText = $('#status-text');
const inverterBtn = $('#inverter');
function updateStatus({ realization = true } = {}) {
  const key = shapeKey();
  const sh = SHAPE[key];
  const tone = S.engaged ? sh.tone : 'idle';
  const msg = S.engaged ? sh.msg : key === 'cosRaw' ? 'Idle. Cosinusoidal operation will need a Phase Inverter.' : 'Idle. Engage to measure inverse reactive current.';
  if (statusText.textContent !== msg) {
    statusText.textContent = msg;
    animate(statusText, { opacity: [0, 1], translateX: [-6, 0], duration: 350, ease: 'outQuad' });
  }
  statusEl.dataset.tone = tone;
  inverterBtn.hidden = key !== 'cosRaw';
  // garbled drive + blinking amber lamp only while un-inverted cosine runs
  animate(S, { garble: key === 'cosRaw' ? 1 : 0, duration: 600, ease: 'inOutQuad' });
  if (S.engaged && realization) animate(S, { realization: sh.real, duration: 1800, ease: 'outQuart' });
}

function fitInverter() {
  if (S.inverter) return;
  finishIntro();
  S.inverter = true;
  inverter.group.visible = true;
  createTimeline()
    .add(inverter.group.scale, { x: [0.001, 1], y: [0.001, 1], z: [0.001, 1], duration: 900, ease: 'outElastic(1, .6)' }, 0)
    .add(inverter.fx.hover, { value: [1, 0], duration: 1400, ease: 'outQuad' }, 200);
  updateStatus();
}
inverterBtn.addEventListener('click', fitInverter);

/* ---------- leader-line labels ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
const leadersEl = $('#leaders');
const labelsEl = $('#labels');
const labels = parts.map((p) => {
  const g = document.createElementNS(SVGNS, 'g');
  const line = document.createElementNS(SVGNS, 'line');
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('r', '3');
  g.append(line, dot);
  leadersEl.appendChild(g);
  const el = document.createElement('div');
  el.className = 'plabel';
  el.textContent = p.name;
  labelsEl.appendChild(el);
  return { p, g, line, dot, el, s: { o: 0, len: 0 } };
});

function setExploded(on) {
  finishIntro();
  S.exploded = on;
  explodeBtn.classList.toggle('on', on);
  explodeBtn.textContent = on ? 'Assemble' : 'Explode';

  // Dolly the camera out (or back in) so the exploded parts fit.
  const offset = camera.position.clone().sub(controls.target);
  const zoom = { k: 1 };
  animate(zoom, {
    k: on ? 1.3 : 1 / 1.3, duration: 1400, ease: 'inOutQuad',
    onUpdate: () => camera.position.copy(controls.target).addScaledVector(offset, zoom.k),
  });

  const target = (axis) => (_, i) => (on ? parts[i].explode[axis] : 0);
  animate(parts.map((p) => p.group.position), {
    x: target('x'), y: target('y'), z: target('z'),
    delay: stagger(55, { from: on ? 'first' : 'last' }),
    duration: on ? 1500 : 1100,
    ease: on ? 'outElastic(1, .75)' : 'outExpo',
  });
  animate(hatch.position, {
    x: on ? HATCH_OUT.x : 0, y: on ? HATCH_OUT.y : 0, z: on ? HATCH_OUT.z : 0,
    delay: on ? 100 : 250,
    duration: 900,
    ease: on ? 'outQuad' : 'inOutQuad',
  });
  animate(hatchState, { open: on ? 1 : 0, delay: on ? 300 : 0, duration: on ? 800 : 700, ease: on ? 'inQuad' : 'outQuad' });
  animate(brushStates, {
    lift: on ? 0.6 : 0,
    delay: stagger(14, { from: 'center' }),
    duration: on ? 1300 : 900,
    ease: on ? 'outElastic(1, .6)' : 'outExpo',
  });
  animate(labels.map((l) => l.s), {
    o: on ? 1 : 0,
    len: on ? [0, 1] : 0,
    delay: stagger(45, { start: on ? 500 : 0 }),
    duration: on ? 700 : 250,
    ease: on ? 'outQuart' : 'outQuad',
  });
}

function setWave(name) {
  if (name === S.wave) return;
  P.prev = S.wave;
  P.prevDir = S.dir;
  S.wave = name;
  S.dir = name === 'cos' ? -1 : 1;
  document.querySelectorAll('#wave button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.wave === name)));
  // Morph from the old driver to the new one.
  animate(P, { blend: [0, 1], duration: 900, ease: 'inOutQuad' });
  updateStatus();
}

const freqIn = $('#freq'), viscIn = $('#visc');
const freqOut = $('#freq-out'), viscOut = $('#visc-out');
freqIn.addEventListener('input', () => {
  P.freq = +freqIn.value;
  freqOut.textContent = `${P.freq.toFixed(2)} Hz`;
});
viscIn.addEventListener('input', () => {
  P.visc = +viscIn.value;
  viscOut.textContent = `${P.visc.toFixed(2)} Zahn`;
});

engageBtn.addEventListener('click', () => setEngaged(!S.engaged));
explodeBtn.addEventListener('click', () => setExploded(!S.exploded));
document.querySelectorAll('#wave button').forEach((b) => b.addEventListener('click', () => setWave(b.dataset.wave)));
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'e' || e.key === 'E') setEngaged(!S.engaged);
  if (e.key === 'x' || e.key === 'X') setExploded(!S.exploded);
  if (e.key === 'f' || e.key === 'F') setFocus(!hero.classList.contains('focus'));
  if (e.key === 'Escape') setFocus(false);
});

/* ---------- hover / tap: gold ink outline + tooltip ---------- */
const tip = $('#tip');
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pointer = { x: 0, y: 0, dirty: false, inside: false };
let hovered = null;

// Pointer -> ray, relative to the canvas (the page scrolls).
function rayFrom(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

// The brushes are thin, so instead of demanding an exact hit, find where
// the pointer ray passes closest to the brush row and accept anything
// within a brush-width or so, unless something solid is clearly in front.
const rowA = new THREE.Vector3(), rowB = new THREE.Vector3();
const onRay = new THREE.Vector3(), onRow = new THREE.Vector3();
function brushRayHit(firstHit) {
  const lift = brushStates[NB >> 1].lift;
  rowA.set(-1.9, 1.06 + lift, 0);
  rowB.set(1.9, 1.06 + lift, 0);
  brushes.group.localToWorld(rowA);
  brushes.group.localToWorld(rowB);
  const d2 = raycaster.ray.distanceSqToSegment(rowA, rowB, onRay, onRow);
  if (d2 > 0.15 * 0.15) return null;
  const along = raycaster.ray.origin.distanceTo(onRay);
  if (firstHit && firstHit.distance < along - 0.3 && !isPluckable(partById[firstHit.object.userData.part])) return null;
  return { i: brushIndexAt(onRow), point: onRow.clone() };
}

function pick(x, y) {
  rayFrom(x, y);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (brushRayHit(hit)) return partById.brushes;
  return hit ? partById[hit.object.userData.part] : null;
}
function setHovered(p) {
  if (p === hovered) return;
  if (hovered) animate(hovered.fx.hover, { value: 0, duration: 250, ease: 'outQuad' });
  if (p) animate(p.fx.hover, { value: 1, duration: 200, ease: 'outQuad' });
  hovered = p;
}
const isPluckable = (p) => p && (p.id === 'brushes' || p.id === 'rail');
// Places in the write-up that name each part (filled in below, from links
// written as [name](#part:<id>) in post.md).
const refsByPart = {};
const canHover = matchMedia('(hover: hover)').matches;
// Whether clicking (or tapping again) on this part can take you to the text;
// a click on the brushes or pipes plucks them instead.
const linksToText = (p) => !!refsByPart[p.id] && !isPluckable(p);
function showTip(p, x, y) {
  const changed = p !== hovered;
  setHovered(p);
  canvas.classList.toggle('hovering', !!p && !isPluckable(p));
  canvas.classList.toggle('pluckable', isPluckable(p));
  if (!p) {
    tip.hidden = true;
    return;
  }
  if (changed) {
    tip.querySelector('strong').textContent = p.name;
    // The part's excerpt from the original text, its own words picked out.
    const quote = tip.querySelector('span');
    quote.replaceChildren(...p.info.split(/\[\[|\]\]/).map((t, i) =>
      i % 2 ? Object.assign(document.createElement('mark'), { textContent: t }) : document.createTextNode(t)));
    quote.hidden = !p.info;
    const more = tip.querySelector('.tip-more');
    more.hidden = !linksToText(p);
    more.textContent = canHover ? 'Click to find it in the text ↓' : 'Tap again to find it in the text ↓';
    tip.hidden = false;
    animate(tip, { opacity: [0, 1], translateY: [6, 0], duration: 220, ease: 'outQuad' });
  }
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(x + 18, window.innerWidth - w - 12)}px`;
  tip.style.top = `${Math.min(Math.max(12, y + 18), window.innerHeight - h - 12)}px`;
}

/* ---------- grab & pluck the brushes ---------- */
const dragPlane = new THREE.Plane();
const planeHit = new THREE.Vector3();
const camDir = new THREE.Vector3();
let grab = null;

function brushIndexAt(worldPoint) {
  const p = brushes.group.worldToLocal(worldPoint.clone());
  return THREE.MathUtils.clamp(Math.round(((p.x + 1.84) / 3.68) * (NB - 1)), 0, NB - 1);
}

// Capture phase on window, so a grab starts before OrbitControls sees the
// pointer and begins orbiting.
window.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas || e.button > 0) return;
  rayFrom(e.clientX, e.clientY);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  let target = brushRayHit(hit);
  if (!target && hit && isPluckable(partById[hit.object.userData.part])) target = { i: brushIndexAt(hit.point), point: hit.point };
  if (!target) return;
  e.stopPropagation();
  finishIntro();
  controls.autoRotate = false;
  // Drag on a vertical plane facing the camera, through the grabbed point.
  camera.getWorldDirection(camDir).setY(0);
  if (camDir.lengthSq() < 1e-4) camDir.set(0, 0, 1);
  dragPlane.setFromNormalAndCoplanarPoint(camDir.normalize(), target.point);
  const { i } = target;
  grab = { i, x: e.clientX, y: e.clientY, y0: target.point.y, u0: str.u[i], moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  canvas.classList.add('grabbing');
  showTip(null);
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (grab) {
    if (!grab.moved && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 4) return;
    grab.moved = true;
    rayFrom(e.clientX, e.clientY);
    if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
      str.held = grab.i;
      str.heldU = THREE.MathUtils.clamp(grab.u0 + planeHit.y - grab.y0, -U_MAX, U_MAX);
    }
    return;
  }
  if (e.pointerType !== 'mouse') return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.dirty = true;
  pointer.inside = true;
});
canvas.addEventListener('pointerleave', (e) => {
  // Touch fires pointerleave right after every tap; only a mouse leaving
  // the canvas should clear the tooltip.
  if (grab || e.pointerType !== 'mouse') return;
  pointer.inside = false;
  showTip(null);
});

let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
function endGrab(e) {
  if (!grab) return false;
  if (!grab.moved) {
    // A tap is a pluck: kick the brush (and its neighbours) upward.
    str.pluck(grab.i, 4.5);
  }
  str.held = -1;
  grab = null;
  canvas.classList.remove('grabbing');
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  pointer.dirty = true;
  return true;
}
canvas.addEventListener('pointercancel', endGrab);
canvas.addEventListener('pointerup', (e) => {
  if (endGrab(e)) return;
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) >= 8) return; // a drag, not a click
  const p = pick(e.clientX, e.clientY);
  if (e.pointerType === 'mouse') {
    if (p && linksToText(p)) showInText(p);
    return;
  }
  // Touch: the first tap shows the datasheet entry; tapping the same part
  // again goes to where the text mentions it.
  if (p && p === hovered && !tip.hidden && linksToText(p)) showInText(p);
  else showTip(p, e.clientX, e.clientY - 120);
});

/* ---------- linking the write-up and the machine ---------- */
const INSIDE = new Set(['winding', 'spring']); // hidden under the casing until it's exploded
const litRefs = (p, on) => refsByPart[p.id]?.forEach((a) => a.classList.toggle('lit', on));
for (const a of document.querySelectorAll('a[href^="#part:"]')) {
  const p = partById[a.getAttribute('href').slice('#part:'.length)];
  if (!p) continue;
  a.classList.add('part-ref');
  a.title = `${p.name}: show it on the machine`;
  (refsByPart[p.id] ||= []).push(a);
  // Hovering a name lights the part up, if the machine is on screen.
  a.addEventListener('pointerenter', () => {
    litRefs(p, true);
    if (heroVisible && !pointer.inside) setHovered(p);
  });
  a.addEventListener('pointerleave', () => {
    litRefs(p, false);
    if (hovered === p && !pointer.inside && tip.hidden) setHovered(null);
  });
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showOnMachine(p);
  });
}

// Text -> machine: scroll up, flash the part's outline and show its entry
// next to it. Parts inside the casing need the machine exploded to be seen.
let showTimer = 0;
function showOnMachine(p) {
  finishIntro();
  controls.autoRotate = false;
  hero.scrollIntoView({ block: 'start' });
  const exploding = INSIDE.has(p.id) && !S.exploded;
  if (exploding) setExploded(true);
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    machine.updateMatrixWorld();
    const { w, h } = heroSize();
    const r = canvas.getBoundingClientRect();
    const at = toScreen(new THREE.Vector3().copy(p.anchor).applyMatrix4(p.group.matrixWorld), w, h);
    showTip(p, r.left + at.x, r.top + at.y);
    animate(p.fx.hover, { value: [1, 0.25, 1, 0.25, 1], duration: 1500, ease: 'inOutSine' });
    showTimer = setTimeout(() => {
      if (hovered === p && !pointer.inside) showTip(null);
    }, 4500);
  }, exploding ? 1300 : 700);
}

// Machine -> text: scroll to the first mention and flash every mention.
function showInText(p) {
  const refs = refsByPart[p.id];
  showTip(null);
  setReturnTo(p);
  refs[0].scrollIntoView({ block: 'center' });
  for (const a of refs) {
    a.classList.remove('flash');
    void a.offsetWidth; // restart the animation
    a.classList.add('flash');
  }
}
document.addEventListener('animationend', (e) => e.target.classList?.remove('flash'));

// "Back to the machine": shown while the machine is out of view. After a
// jump from a part, it shows that part again on the way back.
const toMachine = $('#to-machine');
let returnTo = null;
function setReturnTo(p) {
  returnTo = p;
}
toMachine.addEventListener('click', (e) => {
  e.preventDefault();
  const p = returnTo;
  setReturnTo(null);
  if (p) showOnMachine(p);
  else hero.scrollIntoView({ block: 'start' });
});
new IntersectionObserver(([entry]) => {
  const away = entry.intersectionRatio < 0.2;
  toMachine.classList.toggle('show', away);
  // hidden from keyboard and screen readers while it isn't shown
  toMachine.setAttribute('aria-hidden', String(!away));
  toMachine.tabIndex = away ? 0 : -1;
  // back at the machine by other means: forget the part
  if (entry.intersectionRatio > 0.6) setReturnTo(null);
}, { threshold: [0, 0.2, 0.6] }).observe(hero);

/* ============================================================
 * Resize
 * ========================================================== */
// Fitting = a view offset (where on screen the machine's center sits) plus a
// camera distance (how big it is). Both ease together, so the machine glides
// and zooms in one motion instead of snapping to the new center first.
const view = { ox: 0, oy: 0 };
let fitTween = null;
function applyView() {
  const { w, h } = heroSize();
  camera.setViewOffset(w, h, view.ox, view.oy, w, h);
  camera.updateProjectionMatrix();
}
const setDistance = (d) => camera.position.sub(controls.target).setLength(d).add(controls.target);
const FIT_MS = 480;
function fit({ smooth = false, at } = {}) {
  const { w, h } = heroSize();
  const { dist, f } = camHome(at);
  const ox = w / 2 - (f.x0 + f.x1) / 2, oy = h / 2 - (f.y0 + f.y1) / 2;
  fitTween?.pause();
  if (!smooth) {
    view.ox = ox;
    view.oy = oy;
    applyView();
    return;
  }
  // Keep the user's viewing angle; only the distance changes.
  const tw = { ox: view.ox, oy: view.oy, d: camera.position.distanceTo(controls.target) };
  fitTween = animate(tw, {
    ox, oy, d: dist,
    duration: reduceMotion ? 0 : FIT_MS,
    ease: 'inOutQuad',
    onUpdate: () => {
      view.ox = tw.ox;
      view.oy = tw.oy;
      applyView();
      setDistance(tw.d);
    },
  });
}

let fitted = false;
function resize() {
  const { w, h } = heroSize();
  renderer.setSize(w, h, false);
  renderer.getDrawingBufferSize(U.uView.value);
  camera.aspect = w / h;
  sizeScope();
  labels.forEach((l) => (l.w = 0)); // re-measure: label size follows the layout
  fit({ smooth: fitted && controls.enabled });
  fitted = true;
}
window.addEventListener('resize', resize);
resize();

/* ---------- collapsible card: the chevron folds it down to its top row ---------- */
const focusBtn = $('#focus');
const cardBody = $('#card-body');
function setFocus(on) {
  if (on === hero.classList.contains('focus')) return;
  finishIntro();
  // Work out where the card's top edge will end up (it's pinned at the
  // bottom), so the machine can start moving now, alongside the card.
  const card = hero.querySelector('.card').getBoundingClientRect();
  const bodyNow = cardBody.getBoundingClientRect().height;
  const bodyFull = cardBody.firstElementChild.scrollHeight;
  const cardTop = card.bottom - (card.height - bodyNow + (on ? 0 : bodyFull));
  hero.classList.toggle('focus', on);
  fit({ smooth: true, at: { collapsed: on, cardTop } });
  focusBtn.setAttribute('aria-expanded', String(!on));
  focusBtn.setAttribute('aria-label', on ? 'Show controls' : 'Hide controls');
  focusBtn.title = on ? 'Show controls (F)' : 'Hide controls (F)';
  showTip(null);
}
focusBtn.addEventListener('click', () => setFocus(!hero.classList.contains('focus')));

// The wheel zooms over the machine and scrolls the page over the card, title
// and buttons (they sit above the canvas, so their wheel events never reach
// it). While the hero is partly scrolled away, or the page is still moving
// (trackpad momentum on the way back up from the write-up), the wheel keeps
// scrolling instead of suddenly turning into zoom.
let lastScroll = 0;
window.addEventListener('scroll', () => (lastScroll = performance.now()), { passive: true });
window.addEventListener('wheel', (e) => {
  if (e.target !== canvas || e.ctrlKey || e.metaKey) return; // ctrl/⌘ = trackpad pinch: always zoom
  const scrolledAway = hero.getBoundingClientRect().top < -1;
  if (scrolledAway || performance.now() - lastScroll < 300) e.stopPropagation();
}, { capture: true });

// Don't spend frames on the hero once it has scrolled out of view.
let heroVisible = true;
new IntersectionObserver(([entry]) => (heroVisible = entry.isIntersecting)).observe(hero);

/* ============================================================
 * Render loop
 * ========================================================== */
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const ctr = new THREE.Vector3();
let t = 0;

function toScreen(v, W, H) {
  v.project(camera);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
}

let tanCycle = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!heroVisible) return;
  t += dt;

  // Tangential: each asymptote of tan(φ/2) is a spike.
  const cycle = Math.floor((str.phase * 0.5 + Math.PI / 2) / Math.PI);
  if (cycle !== tanCycle) {
    tanCycle = cycle;
    if (S.engaged && weight('tan') > 0.5) animate(S, { spike: [1, 0], duration: 650, ease: 'outExpo' });
  }
  // Pipusoidal: the fan surges on each pip.
  const pip = Math.pow(Math.max(0, Math.sin(str.phase)), 14) * weight('pip');
  // Un-inverted cosine: the amber lamp blinks.
  S.blink = S.garble * (Math.sin(t * 10) > 0 ? 1 : 0);

  rotor.rotation.x += S.rpm * (1 + 0.9 * pip) * dt * 30;
  windRot.rotation.x += S.rpm * (1 + 0.9 * pip) * dt * 4;
  // hatch: dissolves with the casing in the intro, or on its own when exploded
  hatchFx.fade.value = Math.max(casing.fx.fade.value, hatchState.open);
  hatch.visible = hatchState.open < 0.995; // and stops catching the pointer once gone
  // the girdle spring winds and unwinds with the drive
  springRot.rotation.x = Math.sin(str.phase) * 0.5 * S.amp * (1 + S.spike);
  // winding glow: follows realization; flickers while the cosine drive is
  // garbled, flashes on tangent spikes, pulses with pips
  {
    let g = S.rpm * (0.25 + 0.6 * S.realization) * (0.9 + 0.1 * Math.sin(t * 7));
    g *= 1 - S.garble * (Math.random() < 0.35 ? 0.85 : 0);
    g = Math.max(g, S.spike, pip * 0.8);
    windGlow.copper.value = THREE.MathUtils.clamp(g * 0.75, 0, 1);
    windGlow.gold.value = THREE.MathUtils.clamp(g * 1.1, 0, 1);
  }

  // brushes ride the string; glow shows where the energy is
  stepString(dt);
  for (let i = 0; i < NB; i++) {
    const b = brushItems[i];
    b.item.position.y = b.state.lift + str.u[i];
    b.glow.value = THREE.MathUtils.clamp(Math.abs(str.u[i]) * 9 + Math.abs(str.v[i]) * 0.35, 0, 1);
  }
  drawScope();

  // a little sinusoidal depleneration rumble at speed
  const shake = S.rpm * 0.004 * (1 + 2.5 * pip + 2 * S.spike);
  machine.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0);
  // tremie pipes rattle on tangential spikes
  rail.group.rotation.x = (Math.random() - 0.5) * 0.03 * S.spike;

  btnStates.forEach((s, k) => (buttonGlow[k].value = s.g * (0.75 + 0.25 * Math.sin(t * 9 + k))));
  buttonGlow[0].value = Math.max(buttonGlow[0].value, S.spike);
  buttonGlow[1].value = Math.max(buttonGlow[1].value * (1 - S.garble), S.blink);
  const jitter = S.rpm * (0.012 * Math.sin(t * 37) + 0.008 * Math.sin(t * 13)) * (1 + 4 * S.garble);
  const inrush = S.inrush + S.spike * 0.5 + pip * 0.12;
  drawMeter(meters[0], inrush + jitter);
  drawMeter(meters[1], S.realization + jitter * 0.4);
  flatMats.forEach(({ mat, fx }) => (mat.opacity = 1 - fx.fade.value));

  out.inrush.textContent = Math.max(0, (inrush + jitter) * 10).toFixed(1);
  out.real.textContent = (S.realization * 100).toFixed(1);
  out.rpm.textContent = Math.round(S.rpm * (1 + 0.9 * pip) * 1440).toLocaleString();

  controls.update();
  machine.updateMatrixWorld();

  // dashed gold leader lines, pointing away from the machine's center
  const { w: W, h: H } = heroSize();
  const c = toScreen(ctr.set(0, -0.3, 0).applyMatrix4(machine.matrixWorld), W, H);
  for (const l of labels) {
    if (l.s.o <= 0.001 || !l.p.group.visible) {
      l.g.style.opacity = l.el.style.opacity = '0';
      continue;
    }
    const a = toScreen(tmp.copy(l.p.anchor).applyMatrix4(l.p.group.matrixWorld), W, H);
    let dx = a.x - c.x, dy = a.y - c.y;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    const L = (isNarrow() ? 30 : 54) * l.s.len;
    const ex = a.x + dx * L, ey = a.y + dy * L;
    l.line.setAttribute('x1', a.x.toFixed(1));
    l.line.setAttribute('y1', a.y.toFixed(1));
    l.line.setAttribute('x2', ex.toFixed(1));
    l.line.setAttribute('y2', ey.toFixed(1));
    l.dot.setAttribute('cx', a.x.toFixed(1));
    l.dot.setAttribute('cy', a.y.toFixed(1));
    const right = dx >= 0;
    // Keep the label text on screen (phones are narrow).
    const lw = (l.w ||= l.el.offsetWidth);
    const lx = right ? Math.min(ex + 7, W - lw - 6) : Math.max(ex - 7, lw + 6);
    const ly = THREE.MathUtils.clamp(ey, 12, H - 12);
    l.el.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0) translate(${right ? 0 : -100}%, -50%)`;
    const o = a.behind ? '0' : String(l.s.o);
    l.g.style.opacity = o;
    l.el.style.opacity = o;
  }

  if (pointer.inside && (pointer.dirty || controls.autoRotate || S.exploded)) {
    pointer.dirty = false;
    showTip(pick(pointer.x, pointer.y), pointer.x, pointer.y);
  }

  renderer.render(scene, camera);
}

/* ============================================================
 * Intro: title letters + halftone dissolve-in assembly
 * ========================================================== */
const title = $('#title');
title.innerHTML = [...title.textContent]
  .map((c, i) => `<span class="clip"><span class="ch${i < 5 ? ' hl' : ''}">${c}</span></span>`)
  .join('');

let introTl = null;
function finishIntro() {
  // Jump the intro to its end so it can't fight a user-triggered animation.
  if (introTl && !introTl.completed) introTl.seek(introTl.duration);
  introTl = null;
}

function intro() {
  if (reduceMotion) {
    animate('.reveal', { opacity: 1, duration: 1 });
    return;
  }
  const { pos } = camHome();
  camera.position.copy(pos.clone().multiplyScalar(1.5).setY(pos.y + 4));
  controls.enabled = false;

  parts.forEach((p) => {
    p.group.position.copy(p.explode).multiplyScalar(2.4);
    p.fx.fade.value = 1;
  });
  casing.group.scale.set(0.001, 1, 1);
  brushStates.forEach((s) => (s.lift = 2.6));

  introTl = createTimeline({ onComplete: () => (controls.enabled = true) })
    .add('.ch', { translateY: ['110%', '0%'], duration: 900, ease: 'outExpo', delay: stagger(35) }, 0)
    .add('.reveal', { opacity: [0, 1], translateY: [12, 0], duration: 800, ease: 'outQuad', delay: stagger(120) }, 450)
    .add(camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: 2600, ease: 'inOutQuart' }, 0)
    .add(casing.group.scale, { x: 1, duration: 1100, ease: 'outExpo' }, 200)
    .add(parts.map((p) => p.fx.fade), { value: 0, duration: 900, ease: 'outQuad', delay: stagger(90) }, 200)
    .add(parts.map((p) => p.group.position), { x: 0, y: 0, z: 0, duration: 1500, ease: 'outExpo', delay: stagger(90) }, 350)
    .add(brushStates, { lift: 0, duration: 1000, ease: 'outBounce', delay: stagger(16) }, 1100)
    .add(btnStates, { g: [0, 1, 0], duration: 500, ease: 'inOutQuad', delay: stagger(110) }, 2100)
    .add(S, { inrush: [0, 0.3, 0], realization: [0, 0.2, 0], duration: 1100, ease: 'inOutSine' }, 2200);
}

document.fonts.ready.then(() => {
  resize(); // the title's height (and label widths) may have changed
  meters.forEach((m) => (m.last = -1));
  drawBadge();
});

intro();
frame();
