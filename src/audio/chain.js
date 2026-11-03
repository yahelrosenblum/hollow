// Everything that happens to the sound between the ear cells and the speakers.
// This is the complete list, and the interface states it: a 2D correction, a DC blocker,
// a filter at the edge of the grid's band, a resampler (resampler.js) and a safety limiter.
// None of them adds echo or space.

import { LAMBDA2 } from '../sim/numerics.js';

const HALF_ORDER_LOW_HZ = 20;
const REFERENCE_HZ = 1000;
const DC_BLOCK_HZ = 12;

function biquadless(zero, pole, rate) {
  // First-order section by the bilinear transform, with pre-warped corners.
  const warp = (f) => Math.tan((Math.PI * f) / rate);
  const z = warp(zero);
  const p = warp(pole);
  const a0 = 1 + p;
  return { b0: (1 + z) / a0, b1: (z - 1) / a0, a1: (p - 1) / a0 };
}

// A wave from a 2D source falls off as 1/sqrt(frequency) relative to a 3D one once the
// source signal is differentiated at injection. This filter is the matching -3 dB/octave
// slope, built from alternating poles and zeros one octave apart. It makes the response
// from source to ear flat; it does not make the simulation three-dimensional.
export function designHalfOrder(rate) {
  const top = rate / 2;
  const octaves = Math.log2(top / HALF_ORDER_LOW_HZ);
  const pairs = Math.max(2, Math.round(octaves / 2));
  const ratio = (top / HALF_ORDER_LOW_HZ) ** (1 / (2 * pairs));
  const sections = [];
  for (let k = 0; k < pairs; k += 1) {
    const pole = HALF_ORDER_LOW_HZ * ratio ** (2 * k);
    sections.push(biquadless(Math.min(pole * ratio, top * 0.999), pole, rate));
  }
  // Normalise to unity at the reference frequency.
  const w = (2 * Math.PI * REFERENCE_HZ) / rate;
  let gain = 1;
  for (const s of sections) {
    const reNum = s.b0 + s.b1 * Math.cos(w);
    const imNum = -s.b1 * Math.sin(w);
    const reDen = 1 + s.a1 * Math.cos(w);
    const imDen = -s.a1 * Math.sin(w);
    gain *= Math.hypot(reNum, imNum) / Math.hypot(reDen, imDen);
  }
  return { sections, scale: 1 / gain };
}

export class HalfOrderFilter {
  constructor(rate) {
    const { sections, scale } = designHalfOrder(rate);
    this.sections = sections;
    this.scale = scale;
    this.x = new Float64Array(sections.length);
    this.y = new Float64Array(sections.length);
  }

  process(input) {
    let value = input;
    const { sections, x, y } = this;
    for (let k = 0; k < sections.length; k += 1) {
      const s = sections[k];
      const out = s.b0 * value + s.b1 * x[k] - s.a1 * y[k];
      x[k] = value;
      y[k] = out;
      value = out;
    }
    return value * this.scale;
  }
}

export class DcBlocker {
  constructor(rate) {
    this.r = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) / rate);
    this.x = 0;
    this.y = 0;
  }

  process(input) {
    const out = input - this.x + this.r * this.y;
    this.x = input;
    this.y = out;
    return out;
  }
}

class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    Object.assign(this, { b0, b1, b2, a1, a2 });
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function lowPass(cutoff, q) {
  const w = 2 * Math.PI * cutoff;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return new Biquad(((1 - c) / 2) / a0, (1 - c) / a0, ((1 - c) / 2) / a0, (-2 * c) / a0, (1 - alpha) / a0);
}

function notch(frequency, q) {
  const w = 2 * Math.PI * frequency;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return new Biquad(1 / a0, (-2 * c) / a0, 1 / a0, (-2 * c) / a0, (1 - alpha) / a0);
}

// The grid stops carrying waves along its axes at sin(w/2) = lambda, which is 0.3295 of the
// rate. Anything sudden in the room (a door moving, a reed starting) can excite that frequency,
// and it sits there ringing. It's a property of the grid, not of any room, so it doesn't reach
// your ears. These are the only frequency-shaping filters besides the half-order correction.
export const GRID_CUTOFF = (2 * Math.asin(Math.sqrt(LAMBDA2))) / (2 * Math.PI);
const BAND_EDGE = 0.27;

export class GridCutoffFilter {
  constructor() {
    this.sections = [
      lowPass(BAND_EDGE, 0.541),
      lowPass(BAND_EDGE, 1.307),
      notch(GRID_CUTOFF, 3),
    ];
  }

  process(input) {
    let value = input;
    for (const section of this.sections) value = section.process(value);
    return value;
  }
}

// Ear signal to monitor signal, before the limiter. Exports use this and skip the limiter.
export class EarChain {
  constructor(rate) {
    this.halfOrder = new HalfOrderFilter(rate);
    this.dc = new DcBlocker(rate);
    this.cutoff = new GridCutoffFilter();
  }

  process(input) {
    return this.cutoff.process(this.dc.process(this.halfOrder.process(input)));
  }
}

// Hearing protection on the speaker path only. Linked across channels so a loud sound on
// one side cannot shift the stereo image.
export class SafetyLimiter {
  constructor(rate, ceiling = 0.89) {
    this.ceiling = ceiling;
    this.gain = 1;
    this.release = 1 - Math.exp(-1 / (0.25 * rate));
    this.reduction = 0;
  }

  // Returns the gain to apply to this sample of both channels.
  gainFor(left, right) {
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const released = this.gain + (1 - this.gain) * this.release;
    this.gain = peak * released > this.ceiling ? this.ceiling / peak : released;
    this.reduction = 1 - this.gain;
    return this.gain;
  }
}
