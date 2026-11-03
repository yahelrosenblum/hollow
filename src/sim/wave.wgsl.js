// The solver and its probe pass. Everything audible and visible in Hollow comes out of
// these two entry points. src/sim/reference.js is the same algorithm on the CPU.

import {
  FLAG_REED, FLAG_SLOW, FLAG_SOLID, MIRROR_SHIFT, W_AXIAL, W_DIAG,
} from './numerics.js';

export const WORKGROUP_X = 64;

export const MAX_INJECTORS = 32;
export const MAX_TAPS = 32;

// Sizes the host must match when it writes these buffers.
export const STEP_UNIFORM_BYTES = 48;
export const PROBE_ENTRY_FLOATS = 4; // x, y, dx, dy per step

export const WAVE_WGSL = /* wgsl */ `
struct StepParams {
  nx: u32,
  ny: u32,
  lambda2: f32,
  norm: f32,
  axial: f32,
  diagonal: f32,
  reedGain: f32,
  reedLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

struct Coef { m: f32, norm: f32, k: f32, v: f32 };

@group(0) @binding(0) var<uniform> params: StepParams;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> coef: array<Coef>;
@group(1) @binding(0) var<storage, read> cur: array<f32>;
@group(1) @binding(1) var<storage, read> prev: array<f32>;
@group(1) @binding(2) var<storage, read_write> next: array<f32>;

const SOLID: u32 = ${FLAG_SOLID}u;
const SLOW: u32 = ${FLAG_SLOW}u;
const REED: u32 = ${FLAG_REED}u;
const MIRROR_SHIFT: u32 = ${MIRROR_SHIFT}u;
const W_AXIAL: f32 = ${W_AXIAL};
const W_DIAG: f32 = ${W_DIAG};
const REED_LIMIT: f32 = 4.0;

fn edgeConductance(a: f32, b: f32) -> f32 {
  if (a == b) { return a; }
  return 2.0 * a * b / (a + b);
}

fn slowCell(i: i32, f: u32) -> f32 {
  let nx = i32(params.nx);
  var offsets = array<i32, 8>(1, -1, -nx, nx, 1 - nx, -1 - nx, 1 + nx, -1 + nx);
  let own = coef[i];
  let u = cur[i];
  let p = prev[i];
  var L = 0.0;
  var V = 0.0;
  for (var n = 0u; n < 8u; n += 1u) {
    if ((f & (1u << n)) != 0u) {
      let j = i + offsets[n];
      let other = coef[j];
      var w = W_DIAG;
      if (n < 4u) {
        w = W_AXIAL + W_DIAG * f32((f >> (MIRROR_SHIFT + 2u * n)) & 3u);
      }
      let delta = cur[j] - u;
      L += w * edgeConductance(own.k, other.k) * delta;
      if (own.v > 0.0) {
        V += w * min(own.v, other.v) * (delta - (prev[j] - p));
      }
    }
  }
  var norm = own.norm;
  if ((f & REED) != 0u) {
    // Part of the centred damping term: negative while quiet, positive when loud.
    let x = u / params.reedLevel;
    let g = min(REED_LIMIT, -params.reedGain * (1.0 - x * x));
    norm = own.norm / (1.0 + g * own.norm);
  }
  return p + (2.0 * (u - p) + own.m * (params.lambda2 * L + V)) * norm;
}

@compute @workgroup_size(${WORKGROUP_X}, 1)
fn waveStep(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u || id.y == 0u || id.x >= params.nx - 1u || id.y >= params.ny - 1u) { return; }
  let nx = i32(params.nx);
  let i = i32(id.y) * nx + i32(id.x);
  let f = flags[i];
  if ((f & SOLID) != 0u) {
    next[i] = 0.0;
    return;
  }
  if ((f & SLOW) == 0u) {
    let sumA = cur[i + 1] + cur[i - 1] + cur[i - nx] + cur[i + nx];
    let sumD = cur[i - nx + 1] + cur[i - nx - 1] + cur[i + nx + 1] + cur[i + nx - 1];
    let u = cur[i];
    let p = prev[i];
    next[i] = p + (2.0 * (u - p) + params.axial * (sumA - 4.0 * u)
      + params.diagonal * (sumD - 4.0 * u)) * params.norm;
    return;
  }
  next[i] = slowCell(i, f);
}
`;

// Long-term energy per cell: this is what shows standing waves and hot spots, which a single
// field snapshot cannot, because at audio rate waves cross the room within a couple of frames.
export const ENERGY_WGSL = /* wgsl */ `
struct EnergyParams { nx: u32, ny: u32, decay: f32, _pad: f32 };
@group(1) @binding(2) var<storage, read_write> field: array<f32>;
@group(3) @binding(0) var<uniform> params: EnergyParams;
@group(3) @binding(1) var<storage, read_write> energy: array<f32>;

@compute @workgroup_size(${WORKGROUP_X}, 1)
fn energyStep(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.nx) { return; }
  let i = id.y * params.nx + id.x;
  let u = field[i];
  energy[i] = energy[i] * params.decay + u * u;
}
`;

// One small dispatch after each step. It adds source samples into the newest field, then
// reads every tap from it, with sub-cell interpolation so moving points do not zipper.
// Its layout extends the step shader's, so running it costs no rebinding: binding 2 of
// group 1 is the field the step just wrote. Group 2 is left out of the step shader on
// purpose, because a writable buffer visible to every step dispatch slows them all down.
export const PROBE_WGSL = /* wgsl */ `
struct ProbeParams {
  nx: u32,
  injectors: u32,
  taps: u32,
  sampleStride: u32,
};

struct MovingPoint { x: f32, y: f32, dx: f32, dy: f32 };

struct ProbeOut {
  cursor: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  values: array<f32>,
};

const TAP_POINTS: u32 = ${MAX_INJECTORS}u;
const SAMPLES_AT: u32 = ${(MAX_INJECTORS + MAX_TAPS) * PROBE_ENTRY_FLOATS}u;

// Injector points, then tap points, then source samples, all in one buffer: WebGPU only
// guarantees eight storage buffers per stage, and the solver needs five of them.
@group(2) @binding(0) var<uniform> params: ProbeParams;
@group(2) @binding(1) var<storage, read> data: array<f32>;
@group(2) @binding(2) var<storage, read_write> out: ProbeOut;
@group(1) @binding(2) var<storage, read_write> field: array<f32>;

fn cellOf(x: f32, y: f32) -> i32 {
  return i32(floor(y)) * i32(params.nx) + i32(floor(x));
}

fn pointAt(index: u32) -> MovingPoint {
  let at = index * ${PROBE_ENTRY_FLOATS}u;
  return MovingPoint(data[at], data[at + 1u], data[at + 2u], data[at + 3u]);
}

@compute @workgroup_size(1)
fn probe() {
  let step = out.cursor;
  let t = f32(step);
  let nx = i32(params.nx);
  for (var s = 0u; s < params.injectors; s += 1u) {
    let p = pointAt(s);
    let x = p.x + p.dx * t;
    let y = p.y + p.dy * t;
    let i = cellOf(x, y);
    let fx = x - floor(x);
    let fy = y - floor(y);
    let amount = data[SAMPLES_AT + step * params.sampleStride + s];
    field[i] += amount * (1.0 - fx) * (1.0 - fy);
    field[i + 1] += amount * fx * (1.0 - fy);
    field[i + nx] += amount * (1.0 - fx) * fy;
    field[i + nx + 1] += amount * fx * fy;
  }
  for (var a = 0u; a < params.taps; a += 1u) {
    let p = pointAt(TAP_POINTS + a);
    let x = p.x + p.dx * t;
    let y = p.y + p.dy * t;
    let i = cellOf(x, y);
    let fx = x - floor(x);
    let fy = y - floor(y);
    out.values[step * params.taps + a] =
      field[i] * (1.0 - fx) * (1.0 - fy) + field[i + 1] * fx * (1.0 - fy)
      + field[i + nx] * (1.0 - fx) * fy + field[i + nx + 1] * fx * fy;
  }
  out.cursor = step + 1u;
}
`;
