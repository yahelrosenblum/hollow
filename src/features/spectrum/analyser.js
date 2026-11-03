// Live analysis of what the ears receive, and of what they receive compared with what the
// sources put in. Fed only with solver data.

import { EarChain } from '../../audio/chain.js';
import { fft, hann } from '../../audio/analysis.js';

export const FFT_SIZE = 2048;
const HOP = 512;
const SPECTRUM_SMOOTHING = 0.72;
const RESONANCE_SMOOTHING = 0.985;
const FLOOR_DB = -110;
const PEAK_PROMINENCE_DB = 8;
const MAX_PEAKS = 8;
const TRANSFER_SMOOTHING = 0.94;
const MIN_COHERENCE = 0.5;

export function toDb(power) {
  return 10 * Math.log10(Math.max(power, 1e-14));
}

export function hzToBin(hz, rate) {
  return Math.round((hz / rate) * FFT_SIZE);
}

// Peaks standing clear of the spectrum around them, strongest first. A peak's prominence is
// how far it rises above the higher of the lowest points on either side.
export function findPeaks(db, binHz, { minHz = 30, maxPeaks = MAX_PEAKS, prominence = PEAK_PROMINENCE_DB } = {}) {
  const peaks = [];
  const first = Math.max(2, Math.floor(minHz / binHz));
  for (let i = first; i < db.length - 2; i += 1) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1] && db[i] > FLOOR_DB + 10) {
      let left = db[i];
      for (let k = i - 1; k >= Math.max(1, i - 40); k -= 1) {
        if (db[k] > db[i]) break;
        left = Math.min(left, db[k]);
      }
      let right = db[i];
      for (let k = i + 1; k < Math.min(db.length, i + 40); k += 1) {
        if (db[k] > db[i]) break;
        right = Math.min(right, db[k]);
      }
      const rise = db[i] - Math.max(left, right);
      if (rise >= prominence) {
        const a = db[i - 1];
        const b = db[i];
        const c = db[i + 1];
        const denom = a - 2 * b + c;
        const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
        peaks.push({ bin: i, hz: (i + shift) * binHz, db: b - (a - c) * shift * 0.25, prominence: rise });
      }
    }
  }
  peaks.sort((p, q) => q.db - p.db);
  return peaks.slice(0, maxPeaks);
}

// Sharpness of a resonance from its -3 dB width. Null when the width can't be measured
// within the window, rather than a made-up number.
export function estimateQ(db, bin, binHz) {
  const level = db[bin] - 3;
  let left = bin;
  while (left > 0 && db[left] > level) left -= 1;
  let right = bin;
  while (right < db.length - 1 && db[right] > level) right += 1;
  if (left === 0 || right === db.length - 1) return null;
  const interpolate = (a, b) => (level - db[a]) / (db[b] - db[a]);
  const lowEdge = left + interpolate(left, left + 1);
  const highEdge = right - 1 + interpolate(right - 1, right);
  const width = (highEdge - lowEdge) * binHz;
  return width > 0 ? (bin * binHz) / width : null;
}

class Channel {
  constructor(rate) {
    this.chain = new EarChain(rate);
    this.ring = new Float32Array(FFT_SIZE);
    this.power = new Float64Array(FFT_SIZE / 2 + 1);
    this.db = new Float64Array(FFT_SIZE / 2 + 1).fill(FLOOR_DB);
    this.longPower = new Float64Array(FFT_SIZE / 2 + 1);
    this.longDb = new Float64Array(FFT_SIZE / 2 + 1).fill(FLOOR_DB);
  }
}

export class SpectrumAnalyser {
  constructor(rate) {
    this.configure(rate);
  }

  configure(rate) {
    this.rate = rate;
    this.binHz = rate / FFT_SIZE;
    this.left = new Channel(rate);
    this.right = new Channel(rate);
    this.window = hann(FFT_SIZE);
    this.at = 0;
    this.sinceHop = 0;
    this.inputRing = new Float32Array(FFT_SIZE);
    const bins = FFT_SIZE / 2 + 1;
    this.inputDb = new Float64Array(bins).fill(FLOOR_DB);
    this.sxx = new Float64Array(bins);
    this.syy = new Float64Array(bins);
    this.sxyRe = new Float64Array(bins);
    this.sxyIm = new Float64Array(bins);
    this.transferDb = new Float64Array(bins).fill(NaN);
    this.coherence = new Float64Array(bins);
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.reInput = new Float64Array(FFT_SIZE);
    this.imInput = new Float64Array(FFT_SIZE);
    this.frames = 0;
    this.onFrame = null;
  }

  push(values, count, taps, input) {
    for (let n = 0; n < count; n += 1) {
      this.left.ring[this.at] = this.left.chain.process(values[n * taps]);
      this.right.ring[this.at] = this.right.chain.process(values[n * taps + 1]);
      this.inputRing[this.at] = input ? input[n] : 0;
      this.at = (this.at + 1) % FFT_SIZE;
      this.sinceHop += 1;
      if (this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this.frame();
      }
    }
  }

  transform(ring, re, im) {
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = ring[(this.at + i) % FFT_SIZE] * this.window[i];
      im[i] = 0;
    }
    fft(re, im);
  }

  frame() {
    const { re, im, reInput, imInput } = this;
    const norm = 2 / (FFT_SIZE * 0.5);
    const bins = FFT_SIZE / 2 + 1;
    const updates = [this.left, this.right];
    let leftRe = null;
    let leftIm = null;
    for (const channel of updates) {
      this.transform(channel.ring, re, im);
      if (channel === this.left) {
        leftRe = re.slice();
        leftIm = im.slice();
      }
      for (let k = 0; k < bins; k += 1) {
        const power = (re[k] * re[k] + im[k] * im[k]) * norm * norm;
        channel.power[k] = channel.power[k] * SPECTRUM_SMOOTHING + power * (1 - SPECTRUM_SMOOTHING);
        channel.longPower[k] = channel.longPower[k] * RESONANCE_SMOOTHING + power * (1 - RESONANCE_SMOOTHING);
        channel.db[k] = toDb(channel.power[k]);
        channel.longDb[k] = toDb(channel.longPower[k]);
      }
    }

    // Transfer function from what the sources emitted to what the left ear received, by
    // cross-spectrum. Coherence says how much of the output that input actually explains,
    // and bins with too little of it are left blank.
    this.transform(this.inputRing, reInput, imInput);
    const t = TRANSFER_SMOOTHING;
    for (let k = 0; k < bins; k += 1) {
      const xr = reInput[k];
      const xi = imInput[k];
      const yr = leftRe[k];
      const yi = leftIm[k];
      const inputPower = (xr * xr + xi * xi) * norm * norm;
      this.inputDb[k] = this.inputDb[k] * SPECTRUM_SMOOTHING + toDb(inputPower) * (1 - SPECTRUM_SMOOTHING);
      this.sxx[k] = this.sxx[k] * t + (xr * xr + xi * xi);
      this.syy[k] = this.syy[k] * t + (yr * yr + yi * yi);
      this.sxyRe[k] = this.sxyRe[k] * t + (xr * yr + xi * yi);
      this.sxyIm[k] = this.sxyIm[k] * t + (xr * yi - xi * yr);
      const cross = this.sxyRe[k] ** 2 + this.sxyIm[k] ** 2;
      const denom = this.sxx[k] * this.syy[k];
      const coherence = denom > 1e-24 ? cross / denom : 0;
      this.coherence[k] = coherence;
      this.transferDb[k] = coherence >= MIN_COHERENCE && this.sxx[k] > 1e-14
        ? toDb(cross / (this.sxx[k] * this.sxx[k]))
        : NaN;
    }
    this.frames += 1;
    this.onFrame?.();
  }

  peaks() {
    return findPeaks(this.left.db, this.binHz);
  }

  resonances() {
    const peaks = findPeaks(this.left.longDb, this.binHz, { prominence: 6 });
    return peaks.map((p) => ({ ...p, q: estimateQ(this.left.longDb, p.bin, this.binHz) }));
  }
}
