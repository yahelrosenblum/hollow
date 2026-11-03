import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceLog } from '../src/sim/timeline.js';
import { Governor, RATES, chooseRate } from '../src/sim/governor.js';
import { MAX_BATCH_STEPS } from '../src/sim/engine.js';
import { maxLiveBatch } from '../src/sim/host.js';
import { compileGrid, blankGrid } from '../src/sim/compile.js';
import { AIR, MIRROR, STONE } from '../src/sim/materials.js';
import { ReferenceSolver, setGaussian } from '../src/sim/reference.js';
import {
  analyseResponse, arrivalTime, convolve, frequencyResponse, refocusScore, roomModes,
} from '../src/features/lab/measure.js';
import { decodeWav, encodeWav } from '../src/audio/wav.js';
import {
  EXPORT_NOTE, impulseResponseWav, normalisePair, recordingWav, resample,
} from '../src/audio/ir.js';
import { db, peakFrequency, spectrum } from '../src/audio/analysis.js';
import { bakeCpu } from '../src/sim/bake-cpu.js';
import { addObject, createRoom } from '../src/scene/room.js';
import { Recorder, matchedGains } from '../src/features/studio/recorder.js';

const RATE = 16000;

test('source log replays forward exactly what was recorded', () => {
  const log = new SourceLog();
  const injectors = [{ x: 5, y: 6, dx: 0.1, dy: 0 }];
  log.record(100, 4, injectors, Float32Array.from([1, 2, 3, 4]));
  log.record(104, 2, [], new Float32Array(0));
  const a = log.forwardFrom(101, 2);
  assert.deepEqual([...a.samples], [2, 3]);
  assert.ok(Math.abs(a.injectors[0].x - 5.1) < 1e-9);
  const b = log.forwardFrom(104, 10);
  assert.equal(b.count, 2);
  assert.equal(b.injectors.length, 0);
  assert.equal(log.forwardFrom(50, 2), null);
});

test('source log replays backward in reverse order, from the right place', () => {
  const log = new SourceLog();
  log.record(10, 4, [{ x: 0, y: 0, dx: 1, dy: 0 }], Float32Array.from([1, 2, 3, 4]));
  const back = log.backwardFrom(14, 3);
  assert.deepEqual([...back.samples], [4, 3, 2]);
  assert.equal(back.injectors[0].x, 3);
  assert.equal(back.injectors[0].dx, -1);
  assert.equal(log.backwardFrom(10, 3), null);
});

test('going forward from the past discards the old future', () => {
  const log = new SourceLog();
  log.record(0, 10, [{ x: 0, y: 0, dx: 0, dy: 0 }], new Float32Array(10).fill(1));
  log.record(10, 10, [], new Float32Array(0));
  log.truncate(5);
  assert.equal(log.end, 5);
  assert.equal(log.forwardFrom(7, 1), null);
  assert.equal(log.forwardFrom(2, 10).count, 3);
});

test('silent stretches of the log merge, so idle time costs no memory', () => {
  const log = new SourceLog();
  for (let i = 0; i < 1000; i += 1) log.record(i * 10, 10, [], new Float32Array(0));
  assert.equal(log.entries.length, 1);
  assert.equal(log.end, 10000);
});

test('governor picks the fastest rate that leaves headroom', () => {
  assert.equal(chooseRate([
    { rate: 22050, realtime: 1.1 }, { rate: 16000, realtime: 2 }, { rate: 11025, realtime: 4 },
  ]).rate, 16000);
  const busy = chooseRate([{ rate: 16000, realtime: 0.5 }, { rate: 8000, realtime: 0.9 }]);
  assert.equal(busy.rate, 8000);
  assert.equal(busy.confident, false);
});

test('governor steps down on repeated underruns, and only then', () => {
  const g = new Governor(16000, { now: 0 });
  assert.equal(g.note(0, 5000), null);
  assert.equal(g.note(1, 6000), null);
  assert.equal(g.note(2, 7000), 11025);
  g.setRate(11025, 7000);
  assert.equal(g.note(5, 8000), null, 'underruns while settling do not count');
  assert.equal(g.note(5, 20000), null);
});

test('a room rebuild is not evidence of a slow GPU', () => {
  // Regression: a rebuild's brief stall made the governor drop the rate, which stopped all sound.
  const g = new Governor(16000, { now: 0 });
  g.note(1, 5000);
  g.settle(5500);
  assert.equal(g.note(4, 6000), null);
  assert.equal(g.rate, 16000);
  assert.equal(g.note(5, 9000), null);
  assert.equal(g.note(6, 9500), 11025, 'real underruns afterward still count');
});

test('a hidden page is not evidence of a slow GPU', () => {
  // Regression: browsers stall a hidden page's audio, and the rate was permanently lowered for it.
  const g = new Governor(16000, { now: 0 });
  g.note(1, 4000);
  g.setObserved(false, 5000);
  assert.equal(g.note(10, 6000), null);
  assert.equal(g.note(30, 7000), null);
  g.setObserved(true, 8000);
  assert.equal(g.note(30, 9000), null, 'nothing carries over while settling');
  assert.equal(g.rate, 16000);
  assert.equal(g.note(31, 12000), null);
  assert.equal(g.note(32, 12500), 11025, 'real underruns once visible still count');
});

test('catching up after a stall never asks the engine for more than it can run', () => {
  // Regression: at 22 kHz the catch-up cap exceeded the engine's limit, which threw on every tick
  // and stopped the solver for good, in silence.
  for (const rate of RATES) assert.ok(maxLiveBatch(rate) <= MAX_BATCH_STEPS, `${rate} Hz asks for ${maxLiveBatch(rate)}`);
  assert.ok(maxLiveBatch(8000) >= 0.1 * 8000, 'a low rate keeps enough room to catch up');
});

test('governor never goes below the lowest rate, and respects manual control', () => {
  const low = new Governor(RATES[RATES.length - 1], { now: 0 });
  low.note(1, 5000);
  assert.equal(low.note(2, 6000), null);
  const manual = new Governor(16000, { now: 0, automatic: false });
  manual.note(1, 5000);
  assert.equal(manual.note(2, 6000), null);
});

test('arrival time finds the first sound, and refuses silence', () => {
  const trace = new Float32Array(1000);
  trace[400] = 1;
  assert.ok(Math.abs(arrivalTime(trace, 1000) - 0.4) < 1e-9);
  assert.equal(arrivalTime(new Float32Array(100), 1000), null);
});

test('analysis finds the known mode of a duct', () => {
  const nx = 160;
  const ny = 7;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, airSigma: 1, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  solver.inject(23, 3, 1);
  solver.step();
  solver.inject(23, 3, -1);
  const trace = new Float32Array(32768);
  for (let n = 0; n < trace.length; n += 1) {
    solver.step();
    trace[n] = solver.cur[3 * nx + 41];
  }
  const expected = 343 / (2 * ((nx - 2) * compiled.dx));
  const response = frequencyResponse(trace, RATE);
  const modes = roomModes(response, { maxHz: 400, maxModes: 20 });
  assert.ok(modes.some((m) => Math.abs(m.hz - expected) / expected < 0.01), `no mode near ${expected}: ${modes.map((m) => m.hz.toFixed(0))}`);
});

function decayOf(material, airSigma, seconds) {
  const nx = 60;
  const ny = 40;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, borderMaterial: material, airSigma });
  const solver = new ReferenceSolver(compiled);
  solver.inject(17, 13, 1);
  solver.step();
  solver.inject(17, 13, -1);
  const trace = new Float32Array(RATE * seconds);
  for (let n = 0; n < trace.length; n += 1) {
    solver.step();
    trace[n] = solver.cur[25 * nx + 41];
  }
  return analyseResponse(trace, RATE).decay;
}

test('decay time follows the air loss the room was given', () => {
  // With perfect walls, air is the only loss: amplitude falls as exp(-sigma t), so
  // RT60 = ln(1000) / sigma.
  const sigma = 8;
  const measured = decayOf(MIRROR, sigma, 2);
  const expected = Math.log(1000) / sigma;
  assert.ok(Math.abs(measured - expected) / expected < 0.1, `measured ${measured}, expected ${expected}`);
});

test('decay time is longer in a harder room', () => {
  assert.ok(decayOf(MIRROR, 6, 3) > decayOf(STONE, 6, 3));
});

test('decay time refuses to guess when the sound outlasts the recording', () => {
  // Regression: backward integration reports a plausible-looking wrong number here.
  assert.equal(decayOf(MIRROR, 0.5, 1), null);
});

test('running time backward un-happens a source, using the log', () => {
  const nx = 70;
  const ny = 50;
  const grid = blankGrid(nx, ny, AIR);
  for (let y = 0; y < 25; y += 1) grid[y * nx + 35] = MIRROR;
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  const log = new SourceLog();
  const injector = { x: 12.5, y: 20.5, dx: 0.002, dy: -0.001 };
  const total = 3000;
  for (let n = 0; n < total; n += 1) {
    const value = n < 40 ? Math.sin(n * 0.5) * 0.3 : 0;
    log.record(n, 1, value ? [injector] : [], Float32Array.from(value ? [value] : []));
    solver.step();
    if (value) solver.inject(injector.x, injector.y, value);
  }
  assert.ok(solver.peak() > 1e-3);
  solver.reverse();
  for (let clock = total; clock > 0; clock -= 1) {
    const back = log.backwardFrom(clock, 1);
    solver.step();
    if (back.injectors.length) solver.inject(back.injectors[0].x, back.injectors[0].y, back.samples[0]);
  }
  // Everything that ever happened has been undone, so the room is silent again.
  assert.ok(solver.peak() < 1e-3, `field peak after reversal: ${solver.peak()}`);
});

test('refocus score recognises a perfect return and a smeared one', () => {
  const nx = 80;
  const ny = 60;
  const grid = blankGrid(nx, ny, AIR);
  for (let y = 0; y < 30; y += 1) grid[y * nx + 40] = MIRROR;
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  setGaussian(solver, 20, 30, 2);
  const reference = Float32Array.from(solver.cur);
  solver.run(2000);
  const spread = Float32Array.from(solver.cur);
  solver.reverse();
  solver.run(2000);
  const options = { nx, centre: { x: 20, y: 30 }, dx: compiled.dx, wavelength: 0.3 };
  const good = refocusScore(solver.prev, reference, compiled.flags, options);
  const bad = refocusScore(spread, reference, compiled.flags, options);
  assert.ok(good.correlation > 0.999, `correlation ${good.correlation}`);
  assert.ok(good.energyFraction > bad.energyFraction * 3);
  assert.ok(bad.correlation < 0.5);
  assert.ok(good.spotWidth < bad.spotWidth);
});

test('convolution computes exactly', () => {
  const out = convolve(Float32Array.from([1, 2, 3]), Float32Array.from([1, 0, -1]));
  const expected = [1, 2, 2, -2, -3];
  expected.forEach((v, i) => assert.ok(Math.abs(out[i] - v) < 1e-4, `${i}: ${out[i]}`));
});

test('WAV round trip, 32-bit float, stereo, is exact', () => {
  const left = Float32Array.from([0, 0.5, -0.25, 1, -1]);
  const right = Float32Array.from([0.1, -0.1, 0.2, -0.2, 0.3]);
  const decoded = decodeWav(encodeWav([left, right], 44100, { bits: 32, note: 'hello' }));
  assert.equal(decoded.rate, 44100);
  assert.equal(decoded.bits, 32);
  assert.equal(decoded.note, 'hello');
  assert.deepEqual([...decoded.channels[0]], [...left]);
  assert.deepEqual([...decoded.channels[1]], [...right]);
});

test('WAV round trip, 24-bit, is accurate and clamps', () => {
  const left = Float32Array.from([0, 0.5, -0.25, 1, -1, 2]);
  const decoded = decodeWav(encodeWav([left], 48000, { bits: 24 }));
  assert.equal(decoded.bits, 24);
  [0, 0.5, -0.25, 1, -1, 1].forEach((v, i) => assert.ok(Math.abs(decoded.channels[0][i] - v) < 1e-6));
});

test('WAV refuses formats it cannot write, and garbage it cannot read', () => {
  assert.throws(() => encodeWav([new Float32Array(1)], 48000, { bits: 16 }), RangeError);
  assert.throws(() => decodeWav(new ArrayBuffer(64)));
});

test('resampling keeps pitch', () => {
  const input = new Float32Array(16000);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * 500 * i) / 16000);
  const out = resample(input, 16000, 48000);
  assert.ok(Math.abs(out.length - 48000) <= 1);
  const measured = peakFrequency(spectrum(out, 48000, { padTo: 131072 }), 300, 800).frequency;
  assert.ok(Math.abs(measured - 500) < 0.5);
});

test('impulse response export decodes as stereo, normalised, and says what it is', () => {
  const left = new Float32Array(16000);
  const right = new Float32Array(16000);
  left[100] = 0.01;
  right[120] = 0.005;
  const decoded = decodeWav(impulseResponseWav(left, right, 16000));
  assert.equal(decoded.rate, 48000);
  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.note, EXPORT_NOTE);
  const peak = decoded.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 0.89) < 0.01, `peak ${peak}`);
  assert.ok(db(peak) < 0);
});

test('normalising keeps the stereo balance', () => {
  const pair = normalisePair(Float32Array.from([0.5, 0]), Float32Array.from([0.25, 0]), 1);
  assert.ok(Math.abs(pair.left[0] - 1) < 1e-6);
  assert.ok(Math.abs(pair.right[0] - 0.5) < 1e-6);
});

test('an impulse response predicts what the room does to any signal', () => {
  // The whole claim behind exporting a room: convolving a signal with the measured response
  // must give what direct simulation of that signal gives.
  const room = addObject(addObject(createRoom({
    width: 4, height: 3, airLoss: 4, ear: { x: 3, y: 2, angle: 0 },
  }), {
    type: 'wall', points: [{ x: 2, y: 0 }, { x: 2, y: 1.6 }], thickness: 0.2, material: 'wood',
  }), { type: 'rect', x: 0.6, y: 2.5, w: 0.8, h: 0.5, material: 'foam' });
  const rate = 8000;
  const seconds = 0.5;
  const source = { x: 0.8, y: 1 };
  const steps = Math.round(seconds * rate);
  const signal = new Float32Array(steps);
  let state = 5;
  for (let i = 0; i < 2000; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    signal[i] = (state / 2 ** 31 - 1) * 0.2 * Math.sin((Math.PI * i) / 2000);
  }
  const listeners = [{ x: 3.2, y: 2.2 }];
  const impulse = bakeCpu({ room, sources: [{ point: source, stimulus: { kind: 'impulse' } }], listeners, seconds, rate });
  const direct = bakeCpu({ room, sources: [{ point: source, stimulus: { kind: 'samples', signal } }], listeners, seconds, rate });
  const predicted = convolve(signal, impulse.traces[0], steps);
  let error = 0;
  let power = 0;
  for (let n = 0; n < steps; n += 1) {
    error += (predicted[n] - direct.traces[0][n]) ** 2;
    power += direct.traces[0][n] ** 2;
  }
  const residual = 10 * Math.log10(error / power);
  assert.ok(residual < -60, `residual ${residual.toFixed(1)} dB`);
});

test('recorder chunks a take, survives being cut off, and restores it whole', async () => {
  const store = new Map();
  const key = (name, k) => `${name}:${JSON.stringify(k)}`;
  const storage = {
    async put(name, value) {
      store.set(key(name, name === 'chunks' ? [value.recording, value.index] : value.id), value);
    },
    async get(name, k) {
      return store.get(key(name, k));
    },
    async all(name) {
      return [...store.entries()].filter(([k]) => k.startsWith(`${name}:`)).map(([, v]) => v);
    },
    async delete(name, k) {
      store.delete(key(name, k));
    },
  };
  const rec = new Recorder(storage);
  await rec.start(createRoom({ name: 'R' }), 1000, 'take');
  const message = (start, count) => {
    const values = new Float32Array(count * 2);
    const input = new Float32Array(count);
    for (let n = 0; n < count; n += 1) {
      values[n * 2] = start + n;
      values[n * 2 + 1] = -(start + n);
      input[n] = 0.5;
    }
    return { values, input, count, taps: 2, rate: 1000 };
  };
  rec.push(message(0, 600));
  rec.push(message(600, 600));
  await rec.active.writing;
  rec.push(message(1200, 100));
  // No stop(): the browser died. The last unflushed 100 samples are lost, and no more.
  const [cut] = await new Recorder(storage).list();
  assert.equal(cut.open, true);
  assert.equal(cut.frames, 1200);
  const restored = await rec.load(cut);
  assert.equal(restored.frames, 1200);
  assert.equal(restored.left[1199], 1199);
  assert.equal(restored.right[5], -5);
  const done = await rec.stop();
  assert.equal(done.open, false);
  assert.equal(done.frames, 1300);
  await rec.remove(done);
  assert.equal((await rec.list()).length, 0);
});

test('a change of simulation rate ends a take rather than corrupting it', async () => {
  const rec = new Recorder({ put: async () => {} });
  await rec.start(createRoom(), 1000, 'take');
  assert.equal(rec.push({ values: new Float32Array(2), input: new Float32Array(1), count: 1, taps: 2, rate: 1000 }), false);
  assert.equal(rec.push({ values: new Float32Array(2), input: new Float32Array(1), count: 1, taps: 2, rate: 2000 }), true);
});

test('A/B gains match loudness and never clip', () => {
  const quiet = Float32Array.from({ length: 100 }, (_, i) => 0.1 * Math.sin(i));
  const loud = Float32Array.from({ length: 100 }, (_, i) => 0.9 * Math.sin(i));
  const gains = matchedGains(quiet, loud);
  assert.ok(Math.abs(gains.a * 0.1 - gains.b * 0.9) < 1e-6);
  assert.deepEqual(matchedGains(new Float32Array(4), quiet), { a: 1, b: 1 });
});

test('recording export keeps levels, so a quiet take stays quiet', () => {
  const left = new Float32Array(16000);
  for (let i = 0; i < left.length; i += 1) left[i] = 0.01 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
  const decoded = decodeWav(recordingWav(left, left, 16000));
  const later = decoded.channels[0].subarray(24000);
  const peak = later.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 0.01) < 0.002, `peak ${peak}`);
});
