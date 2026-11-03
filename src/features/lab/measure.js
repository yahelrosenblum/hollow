// Numbers about a room, from a measured response. Shared by the Measure panel, Compare and
// Challenge Mode, so a score always means the same thing as the number you can read yourself.

import { EarChain } from '../../audio/chain.js';
import { SOURCE_DELAY_STEPS } from '../../audio/sources.js';
import {
  db, decayTime, fft, nextPowerOfTwo, peakIn, rms,
} from '../../audio/analysis.js';
import { estimateQ, findPeaks } from '../spectrum/analyser.js';

const ARRIVAL_THRESHOLD_DB = -30;
const RESPONSE_SMOOTH_OCTAVES = 1 / 12;

// Ear signal as it would reach the speakers, minus the limiter.
export function throughChain(trace, rate) {
  const chain = new EarChain(rate);
  const out = new Float32Array(trace.length);
  for (let n = 0; n < trace.length; n += 1) out[n] = chain.process(trace[n]);
  return out;
}

// First moment the signal comes within 30 dB of its eventual peak.
export function arrivalTime(trace, rate, thresholdDb = ARRIVAL_THRESHOLD_DB) {
  const peak = peakIn(trace);
  if (peak === 0) return null;
  const level = peak * 10 ** (thresholdDb / 20);
  for (let n = 0; n < trace.length; n += 1) {
    if (Math.abs(trace[n]) >= level) return n / rate;
  }
  return null;
}

export function frequencyResponse(trace, rate) {
  const size = nextPowerOfTwo(trace.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(trace);
  fft(re, im);
  const bins = size / 2 + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) power[k] = re[k] * re[k] + im[k] * im[k];
  const responseDb = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) responseDb[k] = 10 * Math.log10(power[k] + 1e-20);
  return { db: responseDb, power, binHz: rate / size, bins };
}

// A gently smoothed copy for drawing and for judging whether a peak is really a peak.
export function smoothResponse(response, octaves = RESPONSE_SMOOTH_OCTAVES) {
  const { db: values, binHz, power } = response;
  const out = new Float64Array(values.length);
  const prefix = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k += 1) prefix[k + 1] = prefix[k] + power[k];
  const span = 2 ** (octaves / 2);
  for (let k = 1; k < values.length; k += 1) {
    const hz = k * binHz;
    const low = Math.max(1, Math.floor(hz / span / binHz));
    const high = Math.min(values.length - 1, Math.ceil((hz * span) / binHz));
    const mean = (prefix[high + 1] - prefix[low]) / (high - low + 1);
    out[k] = 10 * Math.log10(mean + 1e-20);
  }
  out[0] = out[1];
  return out;
}

export function roomModes(response, { minHz = 25, maxHz = Infinity, maxModes = 8 } = {}) {
  const { db: values, binHz } = response;
  const limit = Math.min(values.length, Math.floor(maxHz / binHz));
  const clipped = values.subarray(0, limit);
  const peaks = findPeaks(clipped, binHz, { minHz, maxPeaks: maxModes, prominence: 8 });
  return peaks.map((p) => ({ ...p, q: estimateQ(clipped, p.bin, binHz) }));
}

// Everything the Measure panel shows, for one measured response at one ear.
export function analyseResponse(trace, rate) {
  const processed = throughChain(trace, rate);
  const response = frequencyResponse(processed, rate);
  const usableHz = rate / 4;
  const arrival = arrivalTime(processed, rate);
  return {
    rate,
    decay: decayTime(processed, rate),
    // The source filter delays everything equally; that delay isn't a property of the room.
    arrival: arrival === null ? null : Math.max(0, arrival - SOURCE_DELAY_STEPS / rate),
    peakDb: db(peakIn(processed)),
    rmsDb: db(rms(processed)),
    modes: roomModes(response, { maxHz: usableHz }),
    response,
    smooth: smoothResponse(response),
    usableHz,
  };
}

// How well a reversal returned the field to where it was. Compared with the constant offset
// removed, since that is silent. Field correlation says how alike they are; the focus numbers
// say how tightly the sound has gathered around the place it started.
export function refocusScore(field, reference, flags, { nx, centre, dx, wavelength }) {
  const solid = 256;
  let meanA = 0;
  let meanB = 0;
  let open = 0;
  for (let i = 0; i < field.length; i += 1) {
    if (!(flags[i] & solid)) {
      meanA += field[i];
      meanB += reference[i];
      open += 1;
    }
  }
  meanA /= open || 1;
  meanB /= open || 1;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  let total = 0;
  let inside = 0;
  let peak = 0;
  const radius = Math.max(1.5, (wavelength / dx) / 2);
  const cx = centre.x;
  const cy = centre.y;
  for (let i = 0; i < field.length; i += 1) {
    if (!(flags[i] & solid)) {
      const a = field[i] - meanA;
      const b = reference[i] - meanB;
      ab += a * b;
      aa += a * a;
      bb += b * b;
      const y = Math.floor(i / nx);
      const x = i - y * nx;
      const e = a * a;
      total += e;
      if (Math.hypot(x - cx, y - cy) <= radius) inside += e;
      if (Math.abs(a) > peak) peak = Math.abs(a);
    }
  }
  const correlation = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;

  // Radius holding half of the field's squared pressure: how wide the focal spot is.
  const radiusCells = focalRadius(field, flags, nx, cx, cy, meanA, total);
  return {
    correlation,
    energyFraction: total > 0 ? inside / total : 0,
    spotWidth: radiusCells * dx * 2,
    peak,
  };
}

function focalRadius(field, flags, nx, cx, cy, mean, total) {
  if (total <= 0) return 0;
  const reach = 200;
  const rings = new Float64Array(reach + 1);
  const ny = Math.floor(field.length / nx);
  for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(ny, cy + reach); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(nx, cx + reach); x += 1) {
      const i = y * nx + x;
      if (!(flags[i] & 256)) {
        const r = Math.round(Math.hypot(x - cx, y - cy));
        if (r <= reach) rings[r] += (field[i] - mean) ** 2;
      }
    }
  }
  let sum = 0;
  for (let r = 0; r <= reach; r += 1) {
    sum += rings[r];
    if (sum >= total / 2) return r;
  }
  return reach;
}

// Linear convolution, for checking an impulse response against direct simulation.
export function convolve(signal, impulse, length = signal.length + impulse.length - 1) {
  const size = nextPowerOfTwo(signal.length + impulse.length);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(signal);
  bRe.set(impulse);
  fft(aRe, aIm);
  fft(bRe, bIm);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let k = 0; k < size; k += 1) {
    re[k] = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    // Conjugated, so running the forward transform again gives the inverse.
    im[k] = -(aRe[k] * bIm[k] + aIm[k] * bRe[k]);
  }
  fft(re, im);
  const out = new Float32Array(length);
  for (let n = 0; n < length; n += 1) out[n] = re[n] / size;
  return out;
}
