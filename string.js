/**
 * A row of masses coupled to their neighbours: a discretized wave equation
 *
 *   ü_i = c² (u_{i-1} − 2u_i + u_{i+1}) − γ u̇_i − k u_i
 *
 * with ghost nodes at each end. `dL` / `dR` are the ghost displacements, so
 * setting one to a waveform drives that end; leaving it at 0 pins it.
 * Integrated with semi-implicit Euler, which is stable while c·h < 1.
 */
export function createString(n, { c2 = 900, spring = 3, max = 0.42 } = {}) {
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const s = { n, u, v, c2, spring, max, held: -1, heldU: 0, dL: 0, dR: 0 };

  s.step = (h, damp) => {
    for (let i = 0; i < n; i++) {
      const left = i === 0 ? s.dL : u[i - 1];
      const right = i === n - 1 ? s.dR : u[i + 1];
      v[i] += (s.c2 * (left - 2 * u[i] + right) - damp * v[i] - s.spring * u[i]) * h;
    }
    for (let i = 0; i < n; i++) {
      const x = u[i] + v[i] * h;
      u[i] = x > s.max ? s.max : x < -s.max ? -s.max : x;
    }
    if (s.held >= 0) {
      u[s.held] = s.heldU;
      v[s.held] = 0;
    }
  };

  /** Kick a mass (and, more gently, its neighbours). */
  s.pluck = (i, speed) => {
    v[i] += speed;
    if (i > 0) v[i - 1] += speed * 0.55;
    if (i < n - 1) v[i + 1] += speed * 0.55;
  };

  return s;
}
