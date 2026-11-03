// Acoustic X-Ray: what the sound is doing at one point. It reads five solver cells (the point
// and its four neighbours), so everything here is measured from the field, not estimated
// from the room's shape.

import { hann, nextPowerOfTwo, peakFrequency, spectrum } from '../../audio/analysis.js';
import { C_AIR } from '../../sim/numerics.js';

export const XRAY_TAPS = 5;
const FREQUENCY_WINDOW = 4096;
const AVERAGE_SECONDS = 0.15;
const DC_SECONDS = 0.05;
const VELOCITY_LEAK_SECONDS = 0.08;
const SILENCE = 1e-7;

// How much of the sound's energy is actually travelling. A clean plane wave scores 1; in a
// diffuse or standing field it falls toward 0, and any "direction" would be meaningless.
export const DIRECTION_CONFIDENCE = 0.2;

// Cells for a probe at a point, in solver cell coordinates. Neighbours are one cell away.
export function probeCells(cell) {
  return [
    { x: cell.x, y: cell.y },
    { x: cell.x + 1, y: cell.y },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y - 1 },
    { x: cell.x, y: cell.y + 1 },
  ];
}

export class Probe {
  constructor(rate, dx) {
    this.configure(rate, dx);
  }

  configure(rate, dx) {
    this.rate = rate;
    this.dx = dx;
    this.dt = 1 / rate;
    this.averaging = Math.exp(-this.dt / AVERAGE_SECONDS);
    this.dcFollow = Math.exp(-this.dt / DC_SECONDS);
    this.leak = Math.exp(-this.dt / VELOCITY_LEAK_SECONDS);
    this.windowSize = nextPowerOfTwo(Math.round(rate / 4));
    this.windowSize = Math.min(this.windowSize, FREQUENCY_WINDOW);
    this.history = new Float32Array(this.windowSize);
    this.window = hann(this.windowSize);
    this.reset();
  }

  reset() {
    this.filled = 0;
    this.writeAt = 0;
    this.history.fill(0);
    this.dc = 0;
    this.vx = 0;
    this.vy = 0;
    this.pressure = 0;
    this.pressureSquared = 0;
    this.velocitySquared = 0;
    this.ix = 0;
    this.iy = 0;
    this.peak = 0;
  }

  // values: count * taps interleaved, with this probe's five taps starting at `offset`.
  push(values, count, taps, offset) {
    const {
      averaging, dcFollow, leak, dt, dx, history, windowSize,
    } = this;
    const c2 = C_AIR * C_AIR;
    const gradientScale = 1 / (2 * dx);
    for (let n = 0; n < count; n += 1) {
      const at = n * taps + offset;
      const raw = values[at];
      this.dc = this.dc * dcFollow + raw * (1 - dcFollow);
      const p = raw - this.dc;
      // Momentum: density * dv/dt = -grad p, with density 1 in solver units.
      const gx = (values[at + 1] - values[at + 2]) * gradientScale;
      const gy = (values[at + 4] - values[at + 3]) * gradientScale;
      this.vx = this.vx * leak - gx * dt;
      this.vy = this.vy * leak - gy * dt;
      const a = 1 - averaging;
      this.pressureSquared = this.pressureSquared * averaging + p * p * a;
      this.velocitySquared = this.velocitySquared * averaging + (this.vx ** 2 + this.vy ** 2) * a;
      this.ix = this.ix * averaging + p * this.vx * a;
      this.iy = this.iy * averaging + p * this.vy * a;
      this.pressure = p;
      history[this.writeAt] = p;
      this.writeAt = (this.writeAt + 1) % windowSize;
      if (this.filled < windowSize) this.filled += 1;
    }
    // Keep the reference to c^2 local: energy density = p^2/(2c^2) + v^2/2 for unit density.
    this.energyDensity = this.pressureSquared / (2 * c2) + this.velocitySquared / 2;
  }

  // Time-ordered copy of the recent pressure, for the waveform trace.
  recent(length = this.windowSize) {
    const n = Math.min(length, this.filled);
    const out = new Float32Array(n);
    const start = (this.writeAt - n + this.windowSize) % this.windowSize;
    for (let i = 0; i < n; i += 1) out[i] = this.history[(start + i) % this.windowSize];
    return out;
  }

  read() {
    const intensity = Math.hypot(this.ix, this.iy);
    const energy = this.energyDensity ?? 0;
    // A plane wave carries |I| = c * E, which makes this ratio 1.
    const confidence = energy > SILENCE * SILENCE ? Math.min(1, intensity / (C_AIR * energy)) : 0;
    const silent = this.pressureSquared < SILENCE * SILENCE;
    return {
      pressure: this.pressure,
      rms: Math.sqrt(this.pressureSquared),
      energy,
      intensity,
      direction: silent ? null : Math.atan2(this.iy, this.ix),
      confidence,
      hasDirection: !silent && confidence >= DIRECTION_CONFIDENCE,
      silent,
      frequency: this.frequency(),
    };
  }

  // Only reports a frequency once there is a full window of sound to measure it from.
  frequency() {
    const binHz = this.rate / this.windowSize;
    if (this.filled < this.windowSize) return { status: 'measuring', binHz };
    if (this.pressureSquared < SILENCE * SILENCE) return { status: 'silent', binHz };
    const spec = spectrum(this.recent(), this.rate);
    const peak = peakFrequency(spec, binHz * 2, this.rate / 2 - binHz * 2);
    return { status: 'ok', hz: peak.frequency, binHz };
  }
}
