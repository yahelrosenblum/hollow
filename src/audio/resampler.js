// Band-limited interpolation from the simulation rate up to the device rate. A cheap
// interpolator would fold the top of the simulated band back in as audible sizzle.

const TAPS = 24;
const PHASES = 256;
const KAISER_BETA = 8.6;

function bessel0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k += 1) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function buildTable(cutoff) {
  const table = new Float32Array((PHASES + 1) * TAPS);
  const half = TAPS / 2;
  const denom = bessel0(KAISER_BETA);
  for (let phase = 0; phase <= PHASES; phase += 1) {
    const frac = phase / PHASES;
    let sum = 0;
    const row = new Float64Array(TAPS);
    for (let tap = 0; tap < TAPS; tap += 1) {
      const t = tap - half + 1 - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
      const r = t / half;
      const window = Math.abs(r) >= 1 ? 0 : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / denom;
      row[tap] = sinc * window;
      sum += row[tap];
    }
    for (let tap = 0; tap < TAPS; tap += 1) table[phase * TAPS + tap] = row[tap] / sum;
  }
  return table;
}

export const RESAMPLER_TAPS = TAPS;

export function createResampleTable(inputRate, outputRate) {
  return buildTable(Math.min(1, (outputRate / inputRate)) * 0.98);
}

// Converts a live stream arriving in blocks. It has to stay fast, so it's linear interpolation
// behind a low-pass. Without the low-pass, anything too high for the room would fold down into
// the band as noise, and nothing later on could tell it from real sound.
const STREAM_CUTOFF = 0.4;
const BUTTERWORTH_Q = Math.SQRT1_2;

function lowPassCoefficients(cutoff) {
  const w = 2 * Math.PI * cutoff;
  const alpha = Math.sin(w) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b1 = (1 - Math.cos(w)) / a0;
  return {
    b0: b1 / 2, b1, b2: b1 / 2, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0,
  };
}

function runBiquad(c, state, value) {
  const out = c.b0 * value + state.z1;
  state.z1 = c.b1 * value - c.a1 * out + state.z2;
  state.z2 = c.b2 * value - c.a2 * out;
  return out;
}

export class StreamResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate;
    // Where the next output falls, in samples from the start of the next block. -1 is the last
    // sample of the previous block, which is as far back as it can ever need.
    this.position = 0;
    this.last = 0;
    this.filter = outputRate < inputRate ? lowPassCoefficients((STREAM_CUTOFF * outputRate) / inputRate) : null;
    this.stages = [{ z1: 0, z2: 0 }, { z1: 0, z2: 0 }];
  }

  process(block) {
    const input = this.filter ? this.filtered(block) : block;
    const { step, last } = this;
    const end = input.length - 1;
    const count = this.position > end ? 0 : Math.floor((end - this.position) / step) + 1;
    const out = new Float32Array(count);
    let { position } = this;
    for (let n = 0; n < count; n += 1) {
      const index = Math.floor(position);
      const frac = position - index;
      const a = index < 0 ? last : input[index];
      const b = index + 1 <= end ? input[index + 1] : a;
      out[n] = a + (b - a) * frac;
      position += step;
    }
    this.position = position - input.length;
    this.last = input[end];
    return out;
  }

  filtered(block) {
    const { filter, stages } = this;
    return block.map((value) => runBiquad(filter, stages[1], runBiquad(filter, stages[0], value)));
  }
}

// Interpolates one value from a mono view of the ring. `read(k)` returns input sample k
// relative to the current integer position, with k running from -(TAPS/2 - 1) to TAPS/2.
export function interpolate(table, frac, read) {
  const scaled = frac * PHASES;
  const phase = Math.floor(scaled);
  const mix = scaled - phase;
  const a = phase * TAPS;
  const b = a + TAPS;
  let out = 0;
  for (let tap = 0; tap < TAPS; tap += 1) {
    const weight = table[a + tap] + (table[b + tap] - table[a + tap]) * mix;
    out += weight * read(tap - TAPS / 2 + 1);
  }
  return out;
}
