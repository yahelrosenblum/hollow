// Runs on the audio thread. Receives ear samples straight from the simulation worker,
// plays them, and tells the worker how much it has consumed. That report is the clock the
// simulation follows, so simulated time cannot drift away from audio time.

import { EarChain, SafetyLimiter } from './chain.js';
import { RESAMPLER_TAPS, createResampleTable, interpolate } from './resampler.js';

const RING_SECONDS = 1;
const CLOCK_EVERY_BLOCKS = 2;
const GAIN_SMOOTH_SECONDS = 0.02;

class HollowOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.simPort = null;
    this.gain = 0.5;
    this.smoothGain = 0;
    this.gainStep = 1 - Math.exp(-1 / (GAIN_SMOOTH_SECONDS * sampleRate));
    this.limiter = new SafetyLimiter(sampleRate);
    this.blocks = 0;
    this.underruns = 0;
    this.configure(16000);
    this.port.onmessage = (event) => this.onControl(event.data);
  }

  configure(simRate) {
    this.simRate = simRate;
    this.capacity = Math.ceil(simRate * RING_SECONDS);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.written = 0;
    this.position = 0;
    this.primed = false;
    this.primeFrames = Math.ceil(simRate * 0.02);
    this.step = simRate / sampleRate;
    this.table = createResampleTable(simRate, sampleRate);
    this.chainL = new EarChain(simRate);
    this.chainR = new EarChain(simRate);
    this.onsetArmed = false;
    this.onsetLevel = 0;
  }

  onControl(message) {
    switch (message.type) {
      case 'sim-port':
        this.simPort = message.port;
        this.simPort.onmessage = (event) => this.onSim(event.data);
        break;
      case 'gain':
        this.gain = Math.max(0, Math.min(1, message.value));
        break;
      default:
        break;
    }
  }

  onSim(message) {
    if (message.type === 'frames') {
      this.push(message.data);
    } else if (message.type === 'configure') {
      this.configure(message.rate);
      this.primeFrames = Math.ceil(message.rate * message.primeSeconds);
    } else if (message.type === 'prime') {
      this.primeFrames = Math.ceil(this.simRate * message.seconds);
    } else if (message.type === 'hold') {
      // Deliberate silence while time is paused or dilated: not an underrun.
      this.primed = false;
      this.position = this.written;
    } else if (message.type === 'arm-onset') {
      this.onsetArmed = true;
      this.onsetLevel = message.level;
      this.simPort.postMessage({ type: 'onset-armed' });
    }
  }

  // Interleaved stereo at the simulation rate.
  push(data) {
    const { capacity, left, right, chainL, chainR } = this;
    let at = this.written;
    for (let i = 0; i + 1 < data.length; i += 2) {
      const index = at % capacity;
      left[index] = chainL.process(data[i]);
      right[index] = chainR.process(data[i + 1]);
      at += 1;
    }
    this.written = at;
  }

  available() {
    return this.written - Math.floor(this.position);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    const frames = outL.length;
    const lookahead = RESAMPLER_TAPS / 2 + 1;
    const { left, right, capacity, table, step } = this;

    if (!this.primed && this.available() >= this.primeFrames + lookahead) this.primed = true;

    let peak = 0;
    for (let n = 0; n < frames; n += 1) {
      this.smoothGain += (this.gain - this.smoothGain) * this.gainStep;
      let l = 0;
      let r = 0;
      if (this.primed) {
        if (this.available() < lookahead) {
          this.primed = false;
          this.underruns += 1;
        } else {
          const index = Math.floor(this.position);
          const frac = this.position - index;
          l = interpolate(table, frac, (k) => left[(index + k + capacity) % capacity]);
          r = interpolate(table, frac, (k) => right[(index + k + capacity) % capacity]);
          this.position += step;
        }
      }
      l *= this.smoothGain;
      r *= this.smoothGain;
      const limit = this.limiter.gainFor(l, r);
      l *= limit;
      r *= limit;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      outL[n] = l;
      if (outR !== outL) outR[n] = r;
    }

    if (this.simPort) {
      if (this.onsetArmed && peak >= this.onsetLevel) {
        this.onsetArmed = false;
        this.simPort.postMessage({ type: 'onset', peak });
      }
      this.blocks += 1;
      if (this.blocks % CLOCK_EVERY_BLOCKS === 0) {
        this.simPort.postMessage({
          type: 'clock',
          consumed: Math.floor(this.position),
          written: this.written,
          underruns: this.underruns,
          reduction: this.limiter.reduction,
          peak,
          primed: this.primed,
        });
      }
    }
    return true;
  }
}

registerProcessor('hollow-output', HollowOutput);
