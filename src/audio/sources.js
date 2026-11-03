// Source signals. A source only decides what number is added to the field at each step;
// where the sound goes after that is entirely up to the wave equation.

const CLAP_SECONDS = 0.012;
const MAX_STREAM_BLOCKS = 16;
const TWO_PI = Math.PI * 2;

function noiseGenerator(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 2 ** 31 - 1;
  };
}

// One value per step, starting at `step`. Phase-locked to the solver clock, so two tones
// with a set phase difference keep exactly that difference.
export function renderTone(out, count, step, rate, { frequency, phase = 0, amplitude = 1 }) {
  for (let n = 0; n < count; n += 1) {
    out[n] = amplitude * Math.sin(TWO_PI * frequency * ((step + n) / rate) + phase);
  }
}

export class ClapSource {
  constructor(rate, amplitude = 1, seed = 7, seconds = CLAP_SECONDS) {
    this.length = Math.max(8, Math.round(rate * seconds));
    this.signal = new Float32Array(this.length);
    const noise = noiseGenerator(seed);
    let mean = 0;
    for (let i = 0; i < this.length; i += 1) {
      const t = i / this.length;
      const envelope = Math.min(1, t * 12) * Math.exp(-t * 5.5);
      this.signal[i] = noise() * envelope * amplitude;
      mean += this.signal[i];
    }
    // No net displacement, so repeated claps cannot push the room's mean pressure around.
    mean /= this.length;
    for (let i = 0; i < this.length; i += 1) this.signal[i] -= mean;
    this.at = 0;
  }

  get done() {
    return this.at >= this.length;
  }

  render(out, count) {
    for (let n = 0; n < count; n += 1) {
      out[n] = this.at < this.length ? this.signal[this.at] : 0;
      this.at += 1;
    }
  }
}

// A click: the exact unit impulse used to measure a room.
export class ImpulseSource {
  constructor(amplitude = 1) {
    this.amplitude = amplitude;
    this.fired = false;
  }

  get done() {
    return this.fired;
  }

  render(out, count) {
    out.fill(0, 0, count);
    if (!this.fired && count > 0) {
      out[0] = this.amplitude;
      this.fired = true;
    }
  }
}

export class ToneSource {
  constructor(rate, { frequency, amplitude = 0.3, phase = 0, delay = 0, rampSeconds = 0.03 }) {
    this.rate = rate;
    this.frequency = frequency;
    this.amplitude = amplitude;
    this.phase = phase;
    this.delaySteps = Math.round(delay * rate);
    this.rampStep = 1 / Math.max(1, rate * rampSeconds);
    this.level = 0;
    this.target = 1;
    this.step = 0;
    this.startClock = null;
  }

  get done() {
    return this.target === 0 && this.level <= 0;
  }

  stop() {
    this.target = 0;
  }

  // `clock` is the solver's step count. Phase comes from it rather than from when this tone
  // happened to start, so two tones with a set phase difference hold exactly that difference.
  render(out, count, clock = this.step) {
    const omega = (TWO_PI * this.frequency) / this.rate;
    if (this.startClock === null) this.startClock = clock;
    for (let n = 0; n < count; n += 1) {
      const now = clock + n;
      if (now - this.startClock < this.delaySteps) {
        out[n] = 0;
      } else {
        // Tones always ramp in and out: a sudden start would be a click, and on a room
        // resonance a sudden full-level tone is not something anyone should hear.
        if (this.level < this.target) this.level = Math.min(this.target, this.level + this.rampStep);
        else if (this.level > this.target) this.level = Math.max(this.target, this.level - this.rampStep);
        out[n] = this.level * this.amplitude * Math.sin(omega * now + this.phase);
      }
      this.step += 1;
    }
  }
}

export class NoiseSource {
  constructor(rate, { amplitude = 0.15, seed = 11, rampSeconds = 0.03 } = {}) {
    this.amplitude = amplitude;
    this.noise = noiseGenerator(seed);
    this.rampStep = 1 / Math.max(1, rate * rampSeconds);
    this.level = 0;
    this.target = 1;
  }

  get done() {
    return this.target === 0 && this.level <= 0;
  }

  stop() {
    this.target = 0;
  }

  render(out, count) {
    for (let n = 0; n < count; n += 1) {
      if (this.level < this.target) this.level = Math.min(this.target, this.level + this.rampStep);
      else if (this.level > this.target) this.level = Math.max(this.target, this.level - this.rampStep);
      out[n] = this.level * this.amplitude * this.noise();
    }
  }
}

// A breath for a reed: noise that's flat once the source chain has differentiated it. Plain
// noise loses its lows to that difference, more so at higher rates, and a reed then starts on
// whichever high mode is nearest instead of the pipe's own note.
const BREATH_LEAK_HZ = 15;

export class BreathSource extends NoiseSource {
  constructor(rate, options) {
    super(rate, options);
    this.leak = 1 - (2 * Math.PI * BREATH_LEAK_HZ) / rate;
    this.sum = 0;
  }

  render(out, count) {
    super.render(out, count);
    for (let n = 0; n < count; n += 1) {
      this.sum = this.sum * this.leak + out[n];
      out[n] = this.sum;
    }
  }
}

// Plays a decoded buffer, such as a dropped audio file, once or looping.
export class BufferSource {
  constructor(signal, { loop = false, amplitude = 1 } = {}) {
    this.signal = signal;
    this.loop = loop;
    this.amplitude = amplitude;
    this.at = 0;
    this.stopped = false;
  }

  get done() {
    return this.stopped || (!this.loop && this.at >= this.signal.length);
  }

  stop() {
    this.stopped = true;
  }

  render(out, count) {
    for (let n = 0; n < count; n += 1) {
      if (this.stopped) {
        out[n] = 0;
      } else {
        if (this.loop && this.at >= this.signal.length) this.at = 0;
        out[n] = this.at < this.signal.length ? this.signal[this.at] * this.amplitude : 0;
        this.at += 1;
      }
    }
  }
}

// Microphone samples arriving in blocks from the audio thread. An empty queue plays silence
// rather than repeating anything.
export class StreamSource {
  constructor(amplitude = 1) {
    this.amplitude = amplitude;
    this.queue = [];
    this.offset = 0;
    this.stopped = false;
  }

  get done() {
    return this.stopped;
  }

  stop() {
    this.stopped = true;
  }

  // A voice fed live falls behind if the clocks disagree. Dropping the oldest audio keeps the
  // delay bounded, which matters more for a live voice than an occasional small gap.
  push(block) {
    this.queue.push(block);
    while (this.queue.length > MAX_STREAM_BLOCKS) {
      this.queue.shift();
      this.offset = 0;
    }
  }

  render(out, count) {
    let n = 0;
    while (n < count && this.queue.length) {
      const block = this.queue[0];
      const take = Math.min(count - n, block.length - this.offset);
      for (let k = 0; k < take; k += 1) out[n + k] = block[this.offset + k] * this.amplitude;
      n += take;
      this.offset += take;
      if (this.offset >= block.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    out.fill(0, n, count);
  }
}

const SOURCE_FILTER_TAPS = 47;
// Of the simulation rate. Its stopband starts at about 0.32, just below the grid's axial
// cutoff at 0.3295, where the trapped waves live.
const SOURCE_CUTOFF = 0.26;
export const SOURCE_DELAY_STEPS = (SOURCE_FILTER_TAPS - 1) / 2;

function sourceFilterTaps() {
  const taps = new Float64Array(SOURCE_FILTER_TAPS);
  const middle = SOURCE_DELAY_STEPS;
  let sum = 0;
  for (let n = 0; n < SOURCE_FILTER_TAPS; n += 1) {
    const t = n - middle;
    const sinc = t === 0 ? 2 * SOURCE_CUTOFF : Math.sin(2 * Math.PI * SOURCE_CUTOFF * t) / (Math.PI * t);
    const window = 0.42 + 0.5 * Math.cos((Math.PI * t) / middle) + 0.08 * Math.cos((2 * Math.PI * t) / middle);
    taps[n] = sinc * window;
    sum += taps[n];
  }
  return taps.map((v) => v / sum);
}

const SOURCE_TAPS = sourceFilterTaps();

// What every source goes through on its way into the grid. Near its cutoff, a finite-difference
// grid carries waves that barely move: they get trapped, never reach an absorber, and ring on
// as a false high-frequency tail. A band-limited input never excites them. See DECISIONS.md.
export class SourceFilter {
  constructor() {
    this.history = new Float64Array(SOURCE_FILTER_TAPS);
    this.at = 0;
    this.diff = new Differentiator();
  }

  process(values, count) {
    const { history } = this;
    for (let n = 0; n < count; n += 1) {
      history[this.at] = values[n];
      let out = 0;
      let read = this.at;
      for (let k = 0; k < SOURCE_FILTER_TAPS; k += 1) {
        out += SOURCE_TAPS[k] * history[read];
        read = read === 0 ? SOURCE_FILTER_TAPS - 1 : read - 1;
      }
      this.at = (this.at + 1) % SOURCE_FILTER_TAPS;
      values[n] = out;
    }
    this.diff.process(values, count);
  }
}

// Injects a signal's first difference. See chain.js for why that, with the half-order
// filter at the ear, gives a flat response from source to ear.
export class Differentiator {
  constructor() {
    this.last = 0;
  }

  process(values, count) {
    let { last } = this;
    for (let n = 0; n < count; n += 1) {
      const value = values[n];
      values[n] = value - last;
      last = value;
    }
    this.last = last;
  }
}
