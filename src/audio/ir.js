// Turning a measured room response into a file a DAW can use. The solver's output goes through
// the same disclosed steps as the speaker path, minus the limiter, and nothing else: no
// reverb, no shaping, no fade beyond a few milliseconds to avoid a click at the very end.

import { EarChain } from './chain.js';
import { RESAMPLER_TAPS, createResampleTable, interpolate } from './resampler.js';
import { encodeWav } from './wav.js';

const FADE_SECONDS = 0.01;
const PEAK_TARGET = 0.89;
export const EXPORT_NOTE = 'Hollow 2D wave-equation simulation. A creative tool, not a measurement of a real 3D space.';

export function resample(signal, fromRate, toRate) {
  if (fromRate === toRate) return signal.slice();
  const table = createResampleTable(fromRate, toRate);
  const length = Math.floor((signal.length * toRate) / fromRate);
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  const read = (index) => (k) => {
    const at = index + k;
    return at >= 0 && at < signal.length ? signal[at] : 0;
  };
  for (let n = 0; n < length; n += 1) {
    const position = n * step;
    const index = Math.floor(position);
    out[n] = interpolate(table, position - index, read(index));
  }
  return out;
}

function processed(trace, rate) {
  const chain = new EarChain(rate);
  const out = new Float32Array(trace.length);
  for (let n = 0; n < trace.length; n += 1) out[n] = chain.process(trace[n]);
  return out;
}

function fadeEnd(signal, rate) {
  const count = Math.min(signal.length, Math.ceil(rate * FADE_SECONDS));
  for (let i = 0; i < count; i += 1) signal[signal.length - 1 - i] *= i / count;
  return signal;
}

// Peak-normalised stereo. Both channels get the same gain, so the stereo image survives.
export function normalisePair(left, right, target = PEAK_TARGET) {
  let peak = 0;
  for (let n = 0; n < left.length; n += 1) peak = Math.max(peak, Math.abs(left[n]), Math.abs(right[n]));
  if (peak === 0) return { left, right, gain: 1 };
  const gain = target / peak;
  return { left: left.map((v) => v * gain), right: right.map((v) => v * gain), gain };
}

export function impulseResponseWav(traceL, traceR, simRate, { outputRate = 48000, bits = 32 } = {}) {
  const left = fadeEnd(resample(processed(traceL, simRate), simRate, outputRate), outputRate);
  const right = fadeEnd(resample(processed(traceR, simRate), simRate, outputRate), outputRate);
  const pair = normalisePair(left, right);
  return encodeWav([pair.left, pair.right], outputRate, { bits, note: EXPORT_NOTE });
}

// A recording of what was heard: ear signals through the disclosed chain, without the limiter.
export function recordingWav(traceL, traceR, simRate, { outputRate = 48000, bits = 32 } = {}) {
  const left = resample(processed(traceL, simRate), simRate, outputRate);
  const right = resample(processed(traceR, simRate), simRate, outputRate);
  return encodeWav([left, right], outputRate, { bits, note: EXPORT_NOTE });
}

export { RESAMPLER_TAPS };
