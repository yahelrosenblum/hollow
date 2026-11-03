// CPU twin of the WGSL solver. It exists so the GPU can be checked against something
// readable, and so physics can be tested without a browser. It is not used to make sound.

import {
  FLAG_REED, FLAG_SLOW, FLAG_SOLID, NEIGHBOURS, edgeConductance, edgeWeight, fastCoefficients,
} from './numerics.js';
import { COEF_STRIDE } from './compile.js';

const REED_LIMIT = 4;

export class ReferenceSolver {
  constructor(compiled, { reedGain = 0, reedLevel = 1 } = {}) {
    this.grid = compiled;
    const count = compiled.nx * compiled.ny;
    this.cur = new Float32Array(count);
    this.prev = new Float32Array(count);
    this.next = new Float32Array(count);
    this.steps = 0;
    this.reedGain = reedGain;
    this.reedLevel = reedLevel;
    this.offsets = NEIGHBOURS.map(([ox, oy]) => oy * compiled.nx + ox);
    this.fast = fastCoefficients(compiled.lambda2);
  }

  // Advance one step, then rotate the three fields, exactly as on the GPU.
  step() {
    const { nx, ny, flags, lambda2, g0 } = this.grid;
    const { cur, prev, next } = this;
    const { axial, diagonal } = this.fast;
    const norm = 1 / (1 + g0);

    for (let y = 1; y < ny - 1; y += 1) {
      const row = y * nx;
      for (let x = 1; x < nx - 1; x += 1) {
        const i = row + x;
        const f = flags[i];
        if (f & FLAG_SOLID) {
          next[i] = 0;
        } else if (!(f & FLAG_SLOW)) {
          const sumA = cur[i + 1] + cur[i - 1] + cur[i - nx] + cur[i + nx];
          const sumD = cur[i - nx + 1] + cur[i - nx - 1] + cur[i + nx + 1] + cur[i + nx - 1];
          const u = cur[i];
          const p = prev[i];
          next[i] = p + (2 * (u - p) + axial * (sumA - 4 * u) + diagonal * (sumD - 4 * u)) * norm;
        } else {
          next[i] = this.slowCell(i, f, lambda2);
        }
      }
    }
    this.next = prev;
    this.prev = cur;
    this.cur = next;
    this.steps += 1;
  }

  slowCell(i, f, lambda2) {
    const { coef } = this.grid;
    const { cur, prev, offsets } = this;
    const c = i * COEF_STRIDE;
    const ki = coef[c + 2];
    const vi = coef[c + 3];
    const u = cur[i];
    const p = prev[i];
    let L = 0;
    let V = 0;
    for (let n = 0; n < 8; n += 1) {
      if (f & (1 << n)) {
        const j = i + offsets[n];
        const d = j * COEF_STRIDE;
        const w = edgeWeight(f, n);
        const delta = cur[j] - u;
        L += w * edgeConductance(ki, coef[d + 2]) * delta;
        if (vi > 0) V += w * Math.min(vi, coef[d + 3]) * (delta - (prev[j] - p));
      }
    }
    const m = coef[c];
    const norm = f & FLAG_REED ? this.reedNorm(u, coef[c + 1]) : coef[c + 1];
    return p + (2 * (u - p) + m * (lambda2 * L + V)) * norm;
  }

  // The same step with every intermediate rounded to 32 bits, as a GPU computes it.
  // Much slower, and only for comparing against the GPU without double-precision help.
  stepStrict32() {
    const fr = Math.fround;
    const { nx, ny, flags, lambda2, g0, coef } = this.grid;
    const { cur, prev, next, offsets } = this;
    const axial = fr(this.fast.axial);
    const diagonal = fr(this.fast.diagonal);
    const norm = fr(1 / (1 + g0));
    const lam = fr(lambda2);
    for (let y = 1; y < ny - 1; y += 1) {
      const row = y * nx;
      for (let x = 1; x < nx - 1; x += 1) {
        const i = row + x;
        const f = flags[i];
        if (f & FLAG_SOLID) {
          next[i] = 0;
          continue;
        }
        const u = cur[i];
        const p = prev[i];
        const velocity = fr(2 * fr(u - p));
        if (!(f & FLAG_SLOW)) {
          const sumA = fr(fr(fr(cur[i + 1] + cur[i - 1]) + cur[i - nx]) + cur[i + nx]);
          const sumD = fr(fr(fr(cur[i - nx + 1] + cur[i - nx - 1]) + cur[i + nx + 1]) + cur[i + nx - 1]);
          const four = fr(4 * u);
          const body = fr(fr(velocity + fr(axial * fr(sumA - four))) + fr(diagonal * fr(sumD - four)));
          next[i] = fr(p + fr(body * norm));
        } else {
          const c = i * COEF_STRIDE;
          const ki = coef[c + 2];
          const vi = coef[c + 3];
          let L = 0;
          let V = 0;
          for (let n = 0; n < 8; n += 1) {
            if (f & (1 << n)) {
              const j = i + offsets[n];
              const d = j * COEF_STRIDE;
              const w = fr(edgeWeight(f, n));
              const delta = fr(cur[j] - u);
              const kj = coef[d + 2];
              const K = ki === kj ? ki : fr(fr(fr(2 * ki) * kj) / fr(ki + kj));
              L = fr(L + fr(fr(w * K) * delta));
              if (vi > 0) {
                V = fr(V + fr(fr(w * Math.min(vi, coef[d + 3])) * fr(delta - fr(prev[j] - p))));
              }
            }
          }
          const body = fr(velocity + fr(coef[c] * fr(fr(lam * L) + V)));
          const cellNorm = f & FLAG_REED ? fr(this.reedNorm(u, coef[c + 1])) : coef[c + 1];
          next[i] = fr(p + fr(body * cellNorm));
        }
      }
    }
    this.next = prev;
    this.prev = cur;
    this.cur = next;
    this.steps += 1;
  }

  // Van der Pol negative damping: feeds energy in while quiet, takes it out when loud.
  // It is part of the centred damping term: g < 0 while quiet, g > 0 when loud. Centred
  // damping is stable at any strength, which an explicit term at this grid's limit is not.
  reedNorm(u, norm) {
    const x = u / this.reedLevel;
    const g = Math.min(REED_LIMIT, -this.reedGain * (1 - x * x));
    return norm / (1 + g * norm);
  }

  run(count) {
    for (let n = 0; n < count; n += 1) this.step();
  }

  // Exchanging u and u- reverses time. Valid only where every coefficient is lossless.
  reverse() {
    const { cur } = this;
    this.cur = this.prev;
    this.prev = cur;
  }

  // Adds to the newest pressure state. Called after step(), matching the GPU probe pass.
  inject(x, y, amount) {
    const { nx } = this.grid;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * nx + x0;
    this.cur[i] += amount * (1 - fx) * (1 - fy);
    this.cur[i + 1] += amount * fx * (1 - fy);
    this.cur[i + nx] += amount * (1 - fx) * fy;
    this.cur[i + nx + 1] += amount * fx * fy;
  }

  sample(x, y) {
    const { nx } = this.grid;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * nx + x0;
    const { cur } = this;
    return cur[i] * (1 - fx) * (1 - fy) + cur[i + 1] * fx * (1 - fy)
      + cur[i + nx] * (1 - fx) * fy + cur[i + nx + 1] * fx * fy;
  }

  // Discrete energy of the current state. In a lossless grid this is an exact
  // invariant of the scheme, so any drift is an implementation error or rounding.
  energy() {
    const { nx, ny, flags, coef, lambda2 } = this.grid;
    const { cur, prev, offsets } = this;
    let kinetic = 0;
    let potential = 0;
    for (let i = 0; i < nx * ny; i += 1) {
      const f = flags[i];
      if (f & FLAG_SOLID) continue;
      const c = i * COEF_STRIDE;
      const d = cur[i] - prev[i];
      kinetic += (d * d) / (coef[c] * lambda2);
      for (let n = 0; n < 8; n += 1) {
        if (f & (1 << n) && offsets[n] > 0) {
          const j = i + offsets[n];
          const K = edgeConductance(coef[c + 2], coef[j * COEF_STRIDE + 2]);
          potential += edgeWeight(f, n) * K * (cur[i] - cur[j]) * (prev[i] - prev[j]);
        }
      }
    }
    return kinetic + potential;
  }

  peak() {
    let max = 0;
    for (let i = 0; i < this.cur.length; i += 1) {
      const a = Math.abs(this.cur[i]);
      if (a > max) max = a;
    }
    return max;
  }

  mean() {
    const { flags } = this.grid;
    let sum = 0;
    let open = 0;
    for (let i = 0; i < this.cur.length; i += 1) {
      if (!(flags[i] & FLAG_SOLID)) {
        sum += this.cur[i];
        open += 1;
      }
    }
    return open ? sum / open : 0;
  }
}

// Gives every open cell a Gaussian bump at rest (u = u-), so it has no initial velocity.
export function setGaussian(solver, cx, cy, radius, amplitude = 1) {
  const { nx, ny, flags } = solver.grid;
  const r2 = radius * radius;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = y * nx + x;
      if (flags[i] & FLAG_SOLID) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const v = amplitude * Math.exp(-d2 / (2 * r2));
      solver.cur[i] = v;
      solver.prev[i] = v;
    }
  }
}

// Largest eigenvalue of the update operator, by power iteration. The scheme is stable
// while lambda^2 times this stays at or below 4.
export function operatorEigenvalue(compiled, iterations = 400, seed = 1) {
  const { nx, ny, flags, coef } = compiled;
  const count = nx * ny;
  const offsets = NEIGHBOURS.map(([ox, oy]) => oy * nx + ox);
  let z = new Float64Array(count);
  let next = new Float64Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    z[i] = flags[i] & FLAG_SOLID ? 0 : state / 2 ** 32 - 0.5;
  }
  let estimate = 0;
  for (let it = 0; it < iterations; it += 1) {
    let norm = 0;
    for (let i = 0; i < count; i += 1) {
      const f = flags[i];
      if (f & FLAG_SOLID) {
        next[i] = 0;
        continue;
      }
      const c = i * COEF_STRIDE;
      let L = 0;
      for (let n = 0; n < 8; n += 1) {
        if (f & (1 << n)) {
          const j = i + offsets[n];
          L += edgeWeight(f, n) * edgeConductance(coef[c + 2], coef[j * COEF_STRIDE + 2]) * (z[i] - z[j]);
        }
      }
      next[i] = coef[c] * L;
      norm += next[i] * next[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return 0;
    estimate = norm;
    for (let i = 0; i < count; i += 1) next[i] /= norm;
    [z, next] = [next, z];
  }
  return estimate;
}
