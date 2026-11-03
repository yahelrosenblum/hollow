// Audit checks that need a real GPU. Each compares the WGSL solver with the CPU reference,
// or measures what the GPU does over a long run.

import { blankGrid, compileGrid } from '../sim/compile.js';
import { ReferenceSolver, setGaussian } from '../sim/reference.js';
import { WaveEngine } from '../sim/engine.js';
import {
  AIR, FOAM, GLASS, HEAVY_GAS, MIRROR, REED, STONE, WOOD,
} from '../sim/materials.js';
import { LAMBDA2 } from '../sim/numerics.js';

const RATE = 16000;

function outcome(id, label, target, measured, pass, detail = {}) {
  return { id, label, target, measured, pass, detail };
}

function fill(grid, nx, x0, y0, x1, y1, material) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) grid[y * nx + x] = material;
  }
}

function mixedRoom(nx, ny) {
  const grid = blankGrid(nx, ny, AIR);
  fill(grid, nx, 30, 0, 33, 40, STONE);
  fill(grid, nx, 60, 25, 62, ny - 1, WOOD);
  fill(grid, nx, 80, 10, 95, 18, FOAM);
  fill(grid, nx, 100, 30, 100, 55, GLASS);
  fill(grid, nx, 110, 8, 125, 25, HEAVY_GAS);
  // A diagonal staircase, to exercise the corner rules.
  for (let d = 0; d < 20; d += 1) grid[(55 + d) * nx + 10 + d] = STONE;
  return compileGrid(grid, nx, ny, { rate: RATE, airSigma: 1.5 });
}

function losslessRoom(nx, ny) {
  const grid = blankGrid(nx, ny, AIR);
  fill(grid, nx, Math.floor(nx * 0.4), 0, Math.floor(nx * 0.45), Math.floor(ny * 0.55), MIRROR);
  fill(grid, nx, Math.floor(nx * 0.7), Math.floor(ny * 0.4), Math.floor(nx * 0.72), ny - 1, MIRROR);
  return compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR });
}

function differenceDb(a, b) {
  let error = 0;
  let reference = 0;
  for (let i = 0; i < a.length; i += 1) {
    error += (a[i] - b[i]) ** 2;
    reference += b[i] ** 2;
  }
  return { db: 10 * Math.log10(error / reference + 1e-30), error, reference };
}

function pulseWithCpuTwin(compiled, cx, cy, radius) {
  const reference = new ReferenceSolver(compiled);
  setGaussian(reference, cx, cy, radius);
  return reference;
}

async function runInBlocks(engine, steps, options = {}, block = 1024) {
  let remaining = steps;
  const gathered = [];
  while (remaining > 0) {
    const count = Math.min(block, remaining);
    const values = await engine.runBatch(count, options);
    if (options.taps?.length) gathered.push(values);
    remaining -= count;
  }
  if (!gathered.length) return new Float32Array(0);
  const total = gathered.reduce((sum, part) => sum + part.length, 0);
  const all = new Float32Array(total);
  let offset = 0;
  for (const part of gathered) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

export async function checkGpuMatchesCpu(device, { steps = 4000, nx = 140, ny = 90 } = {}) {
  const compiled = mixedRoom(nx, ny);
  const reference = pulseWithCpuTwin(compiled, 45, 60, 2.5);
  const engine = await WaveEngine.create(device);
  engine.loadGrid(compiled);
  engine.writeField('cur', reference.cur);
  engine.writeField('prev', reference.prev);
  const strict = pulseWithCpuTwin(compiled, 45, 60, 2.5);
  reference.run(steps);
  for (let n = 0; n < steps; n += 1) strict.stepStrict32();
  await runInBlocks(engine, steps);
  const gpu = await engine.readField('cur');
  const { db } = differenceDb(gpu, strict.cur);
  const doublePrecision = differenceDb(gpu, reference.cur).db;
  const roundingFloor = differenceDb(strict.cur, reference.cur).db;
  const wave = (field) => withoutMean(field, compiled.flags).field;
  const waveDb = differenceDb(wave(gpu), wave(strict.cur)).db;
  const waveFloor = differenceDb(wave(strict.cur), wave(reference.cur)).db;
  engine.destroyBuffers();
  return outcome(
    'gpu-vs-cpu',
    `GPU field vs CPU reference, every material, after ${steps.toLocaleString('en-US')} steps`,
    'under -80 dB',
    `${db.toFixed(1)} dB raw, ${waveDb.toFixed(1)} dB with the silent constant offset removed; 32-bit rounding alone gives ${roundingFloor.toFixed(1)} dB raw, ${waveFloor.toFixed(1)} dB without offset`,
    waveDb < -80,
    { db, waveDb, doublePrecision, roundingFloor, waveFloor, steps, nx, ny },
  );
}

// Source injection and interpolated tapping must also agree, including moving points.
export async function checkProbesMatchCpu(device, { steps = 2000, nx = 140, ny = 90 } = {}) {
  const compiled = mixedRoom(nx, ny);
  const reference = new ReferenceSolver(compiled);
  const engine = await WaveEngine.create(device);
  engine.loadGrid(compiled);
  const source = { x: 45.25, y: 60.5, dx: 0.004, dy: -0.002 };
  const tap = { x: 20.75, y: 70.25, dx: 0.003, dy: 0.001 };
  const signal = new Float32Array(steps);
  for (let n = 0; n < steps; n += 1) signal[n] = Math.sin(n * 0.17) * Math.exp(-n / 600);
  const cpuTrace = new Float32Array(steps);
  for (let n = 0; n < steps; n += 1) {
    reference.step();
    reference.inject(source.x + source.dx * n, source.y + source.dy * n, signal[n]);
    cpuTrace[n] = reference.sample(tap.x + tap.dx * n, tap.y + tap.dy * n);
  }
  const gpuTrace = await engine.runBatch(steps, { injectors: [source], taps: [tap], samples: signal });
  const { db } = differenceDb(gpuTrace, cpuTrace);
  engine.destroyBuffers();
  return outcome(
    'gpu-probes',
    'GPU source injection and tapping vs CPU, moving points',
    'under -80 dB',
    `${db.toFixed(1)} dB`,
    db < -80,
    { db },
  );
}

export async function checkReedMatchesCpu(device, { steps = 3000, nx = 90, ny = 40 } = {}) {
  const grid = blankGrid(nx, ny, STONE);
  fill(grid, nx, 5, 18, 80, 21, AIR);
  fill(grid, nx, 6, 18, 7, 21, REED);
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, airSigma: 3 });
  const options = { reedGain: 0.04, reedLevel: 0.2 };
  const reference = new ReferenceSolver(compiled, options);
  const engine = await WaveEngine.create(device);
  engine.loadGrid(compiled);
  engine.setReed(options.reedGain, options.reedLevel);
  setGaussian(reference, 30, 19, 1.5, 0.01);
  engine.writeField('cur', reference.cur);
  engine.writeField('prev', reference.prev);
  reference.run(steps);
  await runInBlocks(engine, steps);
  const gpu = await engine.readField('cur');
  const { db } = differenceDb(gpu, reference.cur);
  const peak = reference.peak();
  engine.destroyBuffers();
  // The reed is chaotic in the limit, so a looser bound applies than for linear materials.
  return outcome(
    'gpu-reed',
    'GPU reed vs CPU reference',
    'under -60 dB',
    `${db.toFixed(1)} dB, peak ${peak.toFixed(3)}`,
    db < -60 && peak > 0.02 && Number.isFinite(peak),
    { db, peak },
  );
}

// A constant pressure offset is silent and carries no wave, so reversal is judged on the
// field with its mean removed, with the raw number reported beside it.
function withoutMean(field, flags) {
  let sum = 0;
  let open = 0;
  for (let i = 0; i < field.length; i += 1) {
    if (!(flags[i] & 256)) {
      sum += field[i];
      open += 1;
    }
  }
  const mean = sum / open;
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i += 1) out[i] = flags[i] & 256 ? 0 : field[i] - mean;
  return { field: out, mean };
}

export async function checkGpuReversal(device, { nx = 300, ny = 180 } = {}) {
  const compiled = losslessRoom(nx, ny);
  const rows = [];
  for (const steps of [16_000, 48_000, 200_000]) {
    const start = pulseWithCpuTwin(compiled, nx * 0.2, ny * 0.5, 3);
    const engine = await WaveEngine.create(device);
    engine.loadGrid(compiled);
    engine.writeField('cur', start.cur);
    engine.writeField('prev', start.prev);
    await runInBlocks(engine, steps);
    engine.reverse();
    await runInBlocks(engine, steps);
    const back = await engine.readField('prev');
    const reference = withoutMean(start.cur, compiled.flags).field;
    const cleaned = withoutMean(back, compiled.flags);
    rows.push({
      steps,
      seconds: steps / RATE,
      waveDb: differenceDb(cleaned.field, reference).db,
      rawDb: differenceDb(back, start.cur).db,
      offset: cleaned.mean,
    });
    engine.destroyBuffers();
  }
  const worst = Math.max(...rows.map((r) => r.waveDb));
  return outcome(
    'gpu-reversal',
    'GPU time reversal returns the waves to their start',
    'under -60 dB residual',
    rows.map((r) => `${r.seconds.toFixed(0)} s: ${r.waveDb.toFixed(1)} dB (raw ${r.rawDb.toFixed(1)})`).join('; '),
    worst < -60,
    { rows },
  );
}

export async function checkGpuEnergy(device, { steps = 1_000_000, nx = 200, ny = 120 } = {}) {
  const compiled = losslessRoom(nx, ny);
  const reference = pulseWithCpuTwin(compiled, nx * 0.2, ny * 0.5, 3);
  const startEnergy = reference.energy();
  const engine = await WaveEngine.create(device);
  engine.loadGrid(compiled);
  engine.writeField('cur', reference.cur);
  engine.writeField('prev', reference.prev);
  const started = performance.now();
  await runInBlocks(engine, steps);
  const seconds = (performance.now() - started) / 1000;
  const checker = new ReferenceSolver(compiled);
  checker.cur = await engine.readField('cur');
  checker.prev = await engine.readField('prev');
  const endEnergy = checker.energy();
  const drift = Math.abs(endEnergy - startEnergy) / Math.abs(startEnergy);
  const peak = checker.peak();
  const mean = checker.mean();
  engine.destroyBuffers();
  return outcome(
    'gpu-energy',
    `GPU energy drift, lossless room, ${steps.toLocaleString('en-US')} steps`,
    'under 0.1%',
    `${(drift * 100).toExponential(3)}%; peak ${peak.toFixed(4)}, mean ${mean.toExponential(2)}`,
    drift < 0.001 && Number.isFinite(peak),
    { startEnergy, endEnergy, drift, peak, mean, seconds },
  );
}

// Throughput with the full audio workload: every step followed by a probe pass.
export async function checkThroughput(device) {
  const rows = [];
  for (const { rate, nx, ny } of [
    { rate: 11025, nx: 335, ny: 196 },
    { rate: 16000, nx: 485, ny: 283 },
    { rate: 22050, nx: 668, ny: 390 },
  ]) {
    const grid = blankGrid(nx, ny, AIR);
    fill(grid, nx, Math.floor(nx * 0.3), 0, Math.floor(nx * 0.31), Math.floor(ny * 0.6), STONE);
    fill(grid, nx, Math.floor(nx * 0.6), Math.floor(ny * 0.4), Math.floor(nx * 0.63), ny - 1, WOOD);
    const compiled = compileGrid(grid, nx, ny, { rate, airSigma: 1.5 });
    const engine = await WaveEngine.create(device);
    engine.loadGrid(compiled);
    const batch = Math.round(rate / 60);
    const injectors = [{ x: 20.5, y: 20.5, dx: 0, dy: 0 }];
    const taps = [{ x: 40.5, y: 40.5, dx: 0, dy: 0 }, { x: 47.5, y: 40.5, dx: 0, dy: 0 }];
    const samples = new Float32Array(batch);
    await engine.runBatch(batch, { injectors, taps, samples });
    const started = performance.now();
    let steps = 0;
    while (performance.now() - started < 1500) {
      await engine.runBatch(batch, { injectors, taps, samples });
      steps += batch;
    }
    const seconds = (performance.now() - started) / 1000;
    const realtime = steps / seconds / rate;
    rows.push({ rate, nx, ny, stepsPerSecond: steps / seconds, realtime, gigacells: (steps * nx * ny) / seconds / 1e9 });
    engine.destroyBuffers();
  }
  const best = rows.filter((r) => r.realtime >= 1.5).map((r) => r.rate);
  return outcome(
    'gpu-throughput',
    'Throughput for a 12 x 7 m room, full audio workload',
    'at least one rate above 1.5x real time',
    rows.map((r) => `${r.rate} Hz: ${r.realtime.toFixed(2)}x (${r.gigacells.toFixed(2)} Gcell/s)`).join('; '),
    best.length > 0,
    { rows, lambda2: LAMBDA2 },
  );
}

export const GPU_CHECKS = Object.freeze({
  checkGpuMatchesCpu,
  checkProbesMatchCpu,
  checkReedMatchesCpu,
  checkGpuReversal,
  checkGpuEnergy,
  checkThroughput,
});
