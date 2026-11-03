import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTION_CONFIDENCE, Probe, XRAY_TAPS, probeCells } from '../src/features/xray/probe.js';
import {
  FFT_SIZE, SpectrumAnalyser, estimateQ, findPeaks,
} from '../src/features/spectrum/analyser.js';
import { blankGrid, compileGrid } from '../src/sim/compile.js';
import { AIR, MIRROR } from '../src/sim/materials.js';
import { cellSizeFor } from '../src/sim/numerics.js';
import { ReferenceSolver } from '../src/sim/reference.js';

const RATE = 16000;

// A plane wave in a duct, travelling in +x, with the probe in the middle of it.
function planeWaveProbeTrace({ frequency = 500, steps = 6000, direction = 1 }) {
  const nx = 3000;
  const ny = 7;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  const sourceX = direction > 0 ? 400 : 2600;
  const probeX = 1500;
  const cells = probeCells({ x: probeX, y: 3 });
  const values = new Float32Array(steps * XRAY_TAPS);
  for (let n = 0; n < steps; n += 1) {
    solver.step();
    const v = Math.sin((2 * Math.PI * frequency * n) / RATE) * 0.02;
    for (let y = 1; y < ny - 1; y += 1) solver.inject(sourceX, y, v);
    cells.forEach((c, t) => { values[n * XRAY_TAPS + t] = solver.sample(c.x, c.y); });
  }
  return { values, dx: compiled.dx, solver, probeX };
}

test('X-Ray pressure equals the solver value at the probe cell', () => {
  const { values, dx, solver, probeX } = planeWaveProbeTrace({ steps: 3000 });
  const probe = new Probe(RATE, dx);
  probe.push(values, 3000, XRAY_TAPS, 0);
  // The probe removes slow DC, so compare against the raw tap it was given.
  const raw = values[(3000 - 1) * XRAY_TAPS];
  assert.ok(Math.abs(raw - solver.cur[3 * 3000 + probeX]) < 1e-5);
  assert.ok(Math.abs(probe.read().pressure - (raw - probe.dc)) < 1e-9);
});

test('X-Ray finds the direction of a known plane wave', () => {
  for (const direction of [1, -1]) {
    const { values, dx } = planeWaveProbeTrace({ direction, steps: 5000 });
    const probe = new Probe(RATE, dx);
    probe.push(values, 5000, XRAY_TAPS, 0);
    const reading = probe.read();
    assert.ok(reading.hasDirection, `confidence ${reading.confidence}`);
    const expected = direction > 0 ? 0 : Math.PI;
    const error = Math.abs(Math.atan2(Math.sin(reading.direction - expected), Math.cos(reading.direction - expected)));
    assert.ok(error < 0.1, `direction off by ${error} rad`);
    assert.ok(reading.confidence > 0.7, `confidence only ${reading.confidence}`);
  }
});

test('a standing wave has no dominant direction, and X-Ray says so', () => {
  const nx = 400;
  const ny = 7;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  // A pure mode of a closed duct: every point oscillates in place.
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < nx - 1; x += 1) {
      const v = Math.cos((6 * Math.PI * (x - 0.5)) / (nx - 2)) * 0.05;
      solver.cur[y * nx + x] = v;
      solver.prev[y * nx + x] = v;
    }
  }
  const steps = 12000;
  const cells = probeCells({ x: 137, y: 3 });
  const values = new Float32Array(steps * XRAY_TAPS);
  for (let n = 0; n < steps; n += 1) {
    solver.step();
    cells.forEach((c, t) => { values[n * XRAY_TAPS + t] = solver.sample(c.x, c.y); });
  }
  const probe = new Probe(RATE, compiled.dx);
  probe.push(values, steps, XRAY_TAPS, 0);
  const reading = probe.read();
  assert.ok(reading.confidence < DIRECTION_CONFIDENCE, `confidence ${reading.confidence}`);
  assert.equal(reading.hasDirection, false);
});

test('X-Ray reports frequency only once it has enough sound, and gets it right', () => {
  const dx = cellSizeFor(RATE);
  const probe = new Probe(RATE, dx);
  const size = probe.windowSize;
  const make = (count, start = 0) => {
    const v = new Float32Array(count * XRAY_TAPS);
    for (let n = 0; n < count; n += 1) {
      const s = Math.sin((2 * Math.PI * 733 * (n + start)) / RATE) * 0.1;
      for (let t = 0; t < XRAY_TAPS; t += 1) v[n * XRAY_TAPS + t] = s;
    }
    return v;
  };
  probe.push(make(100), 100, XRAY_TAPS, 0);
  assert.equal(probe.read().frequency.status, 'measuring');
  probe.push(make(size * 2, 100), size * 2, XRAY_TAPS, 0);
  const { frequency } = probe.read();
  assert.equal(frequency.status, 'ok');
  assert.ok(Math.abs(frequency.hz - 733) < frequency.binHz, `measured ${frequency.hz}`);
});

test('X-Ray reports silence instead of inventing readings', () => {
  const probe = new Probe(RATE, cellSizeFor(RATE));
  probe.push(new Float32Array(50000 * XRAY_TAPS), 50000, XRAY_TAPS, 0);
  const reading = probe.read();
  assert.equal(reading.silent, true);
  assert.equal(reading.direction, null);
  assert.equal(reading.frequency.status, 'silent');
});

function feedTone(analyser, frequency, seconds, { amplitude = 0.3, input = false } = {}) {
  const block = 256;
  const taps = 2;
  const total = Math.floor(RATE * seconds);
  for (let start = 0; start < total; start += block) {
    const values = new Float32Array(block * taps);
    const inp = new Float32Array(block);
    for (let n = 0; n < block; n += 1) {
      const s = amplitude * Math.sin((2 * Math.PI * frequency * (start + n)) / RATE);
      values[n * taps] = s;
      values[n * taps + 1] = s * 0.5;
      if (input) inp[n] = s;
    }
    analyser.push(values, block, taps, input ? inp : null);
  }
}

test('a known tone lands in the correct spectrum bin', () => {
  for (const frequency of [220, 1000, 3100]) {
    const analyser = new SpectrumAnalyser(RATE);
    feedTone(analyser, frequency, 1);
    const [peak] = analyser.peaks();
    assert.ok(peak, `no peak for ${frequency}`);
    assert.ok(Math.abs(peak.hz - frequency) <= analyser.binHz, `${frequency} measured as ${peak.hz}`);
  }
});

test('left and right channels are measured separately', () => {
  const analyser = new SpectrumAnalyser(RATE);
  feedTone(analyser, 1000, 1);
  const bin = Math.round(1000 / analyser.binHz);
  const difference = analyser.left.db[bin] - analyser.right.db[bin];
  assert.ok(Math.abs(difference - 6.02) < 0.5, `L-R is ${difference} dB`);
});

test('two tones are found as two peaks', () => {
  const analyser = new SpectrumAnalyser(RATE);
  const block = 256;
  for (let start = 0; start < RATE; start += block) {
    const values = new Float32Array(block * 2);
    for (let n = 0; n < block; n += 1) {
      const t = (start + n) / RATE;
      values[n * 2] = 0.2 * Math.sin(2 * Math.PI * 500 * t) + 0.1 * Math.sin(2 * Math.PI * 1800 * t);
    }
    analyser.push(values, block, 2, null);
  }
  const hz = analyser.peaks().map((p) => p.hz).sort((a, b) => a - b);
  assert.ok(hz.some((f) => Math.abs(f - 500) < analyser.binHz));
  assert.ok(hz.some((f) => Math.abs(f - 1800) < analyser.binHz));
});

test('transfer function measures a known gain, once coherence allows it', () => {
  const analyser = new SpectrumAnalyser(RATE);
  const block = 256;
  let state = 1;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
  for (let start = 0; start < RATE * 3; start += block) {
    const values = new Float32Array(block * 2);
    const input = new Float32Array(block);
    for (let n = 0; n < block; n += 1) {
      input[n] = noise() * 0.2;
      values[n * 2] = input[n] * 0.25;
    }
    analyser.push(values, block, 2, input);
  }
  // The half-order filter is unity at 1 kHz, so the measured gain there is the true 0.25.
  const bin = Math.round(1000 / analyser.binHz);
  assert.ok(analyser.coherence[bin] > 0.8, `coherence ${analyser.coherence[bin]}`);
  assert.ok(Math.abs(analyser.transferDb[bin] - (20 * Math.log10(0.25))) < 3, `gain ${analyser.transferDb[bin]}`);
});

test('peak finding ignores gentle slopes', () => {
  const db = new Float64Array(200);
  for (let i = 0; i < 200; i += 1) db[i] = -40 - i * 0.05;
  assert.equal(findPeaks(db, 10).length, 0);
});

test('resonance Q comes from the measured width', () => {
  const size = FFT_SIZE / 2 + 1;
  const db = new Float64Array(size);
  const centre = 200;
  const binHz = 8;
  const f0 = centre * binHz;
  const q = 20;
  for (let k = 0; k < size; k += 1) {
    const f = k * binHz;
    const x = q * (f / f0 - f0 / Math.max(f, 1));
    db[k] = -10 * Math.log10(1 + x * x);
  }
  const measured = estimateQ(db, centre, binHz);
  assert.ok(Math.abs(measured - q) / q < 0.1, `Q ${measured}`);
});
