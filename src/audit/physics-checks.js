// The physics audit. Each check runs the CPU reference and returns what it measured next
// to the proposed acceptance criterion. Nothing here is allowed to adjust a target to fit.

import { blankGrid, compileGrid } from '../sim/compile.js';
import { ReferenceSolver, operatorEigenvalue, setGaussian } from '../sim/reference.js';
import {
  C_AIR, FLAG_SOLID, LAMBDA2, LAMBDA2_LIMIT, MAX_OPERATOR_EIGENVALUE,
  massLawTransmission, pressureReflection, pressureTransmission, wallReflection,
} from '../sim/numerics.js';
import {
  AIR, FOAM, GLASS, HEAVY_GAS, MATERIALS, MIRROR, STONE, WOOD,
} from '../sim/materials.js';
import {
  db, decayTime, peakFrequency, peakIn, spectrum,
} from '../audio/analysis.js';
import { bakeCpu } from '../sim/bake-cpu.js';
import { throughChain } from '../features/lab/measure.js';
import { addObject, createRoom } from '../scene/room.js';
import { compileOptionsFor, rasterise, toCell } from '../scene/rasterise.js';

const RATE = 16000;

function result(id, label, target, measured, pass, detail = {}) {
  return { id, label, target, measured, pass, detail };
}

function fillRect(grid, nx, x0, y0, x1, y1, material) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) grid[y * nx + x] = material;
  }
}

// An irregular closed room with rigid lossless walls: the lossless test bed.
function irregularLosslessRoom(nx, ny, lambda2 = LAMBDA2) {
  const grid = blankGrid(nx, ny, AIR);
  fillRect(grid, nx, Math.floor(nx * 0.4), 0, Math.floor(nx * 0.45), Math.floor(ny * 0.55), MIRROR);
  fillRect(grid, nx, Math.floor(nx * 0.7), Math.floor(ny * 0.4), Math.floor(nx * 0.72), ny - 1, MIRROR);
  return compileGrid(grid, nx, ny, { rate: RATE, lambda2, borderMaterial: MIRROR });
}

// The GPU audit runs the full million steps; this CPU run checks the same invariant.
export function checkEnergy({ steps = 200_000, nx = 80, ny = 48 } = {}) {
  const solver = new ReferenceSolver(irregularLosslessRoom(nx, ny));
  setGaussian(solver, nx * 0.2, ny * 0.5, 3);
  const start = solver.energy();
  solver.run(steps);
  const end = solver.energy();
  const drift = Math.abs(end - start) / Math.abs(start);
  return result(
    'energy-drift',
    `Energy drift, lossless room, ${steps.toLocaleString('en-US')} steps`,
    'under 0.1%',
    `${(drift * 100).toExponential(3)}%`,
    drift < 0.001,
    { start, end, drift, peak: solver.peak() },
  );
}

// Why LAMBDA2 sits under the limit: at exactly 3/4 the checkerboard mode has a double root.
function checkerboardAmplitude(solver) {
  const { nx, ny } = solver.grid;
  let sum = 0;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      sum += solver.cur[y * nx + x] * ((x + y) % 2 ? -1 : 1);
    }
  }
  return Math.abs(sum) / (nx * ny);
}

export function checkStabilityMargin({ steps = 100_000, nx = 64, ny = 40 } = {}) {
  const run = (lambda2) => {
    const solver = new ReferenceSolver(irregularLosslessRoom(nx, ny, lambda2));
    setGaussian(solver, nx * 0.2, ny * 0.5, 1.2);
    const peakStart = solver.peak();
    const energyStart = solver.energy();
    solver.run(steps);
    return {
      lambda2,
      peakRatio: solver.peak() / peakStart,
      checkerboard: checkerboardAmplitude(solver),
      energyDrift: Math.abs(solver.energy() - energyStart) / Math.abs(energyStart),
      mean: solver.mean(),
    };
  };
  const atLimit = run(LAMBDA2_LIMIT);
  const chosen = run(LAMBDA2);
  const pass = chosen.peakRatio < 1.01 && Number.isFinite(chosen.energyDrift);
  return result(
    'stability-margin',
    'Field bounded at the chosen time step; limit compared',
    'peak does not grow; compared with lambda^2 = 3/4',
    `peak ratio ${chosen.peakRatio.toFixed(4)} at ${LAMBDA2}, ${atLimit.peakRatio.toFixed(4)} at ${LAMBDA2_LIMIT}`,
    pass,
    { atLimit, chosen },
  );
}

export function checkConstantDrift({ steps = 200_000, nx = 80, ny = 48 } = {}) {
  const solver = new ReferenceSolver(irregularLosslessRoom(nx, ny));
  setGaussian(solver, nx * 0.2, ny * 0.5, 3);
  const meanStart = solver.mean();
  solver.run(steps);
  const drift = Math.abs(solver.mean() - meanStart);
  return result(
    'constant-drift',
    'Constant-pressure drift in a closed room',
    'measured and bounded',
    `${drift.toExponential(3)} after ${steps.toLocaleString('en-US')} steps (pulse peak 1.0)`,
    drift < 1e-2,
    { meanStart, meanEnd: solver.mean(), drift },
  );
}

// Mode frequencies of a rigid rectangle, excited with a pulse and read from the spectrum.
export function checkModes({ steps = 65536, nx = 162, ny = 102 } = {}) {
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  const trace = new Float64Array(steps);
  const source = { x: 23, y: 17 };
  const mic = { x: 97, y: 71 };
  solver.cur[source.y * nx + source.x] = 1;
  solver.prev[source.y * nx + source.x] = 1;
  for (let n = 0; n < steps; n += 1) {
    solver.step();
    trace[n] = solver.cur[mic.y * nx + mic.x];
  }
  const spec = spectrum(trace, RATE);

  // Walls sit half a cell outside the open cells, so the room is exactly (nx-2) * dx long.
  const Lx = (nx - 2) * compiled.dx;
  const Ly = (ny - 2) * compiled.dx;
  const modes = [];
  for (let m = 0; m < 80; m += 1) {
    for (let n = 0; n < 80; n += 1) {
      if (m + n > 0) modes.push({ m, n, f: (C_AIR / 2) * Math.hypot(m / Lx, n / Ly) });
    }
  }
  modes.sort((a, b) => a.f - b.f);
  const limit = RATE / 8;
  const rows = [];
  let worst = 0;
  // A mode is invisible where the source or the mic sits on one of its nodal lines.
  const shape = (mode, p) => Math.abs(
    Math.cos((mode.m * Math.PI * (p.x - 0.5)) / (nx - 2))
    * Math.cos((mode.n * Math.PI * (p.y - 0.5)) / (ny - 2)),
  );
  for (let i = 0; i < modes.length; i += 1) {
    const mode = modes[i];
    if (mode.f >= limit) break;
    const before = i > 0 ? mode.f - modes[i - 1].f : Infinity;
    const after = i < modes.length - 1 ? modes[i + 1].f - mode.f : Infinity;
    const isolation = Math.min(before, after);
    // Only modes clearly separated from their neighbours can be identified without guessing.
    if (isolation >= spec.binHz * 8 && shape(mode, source) > 0.25 && shape(mode, mic) > 0.25) {
      const peak = peakFrequency(spec, mode.f - isolation / 2, mode.f + isolation / 2);
      const error = Math.abs(peak.frequency - mode.f) / mode.f;
      worst = Math.max(worst, error);
      rows.push({ mode: `${mode.m},${mode.n}`, expected: mode.f, measured: peak.frequency, error });
    }
  }
  return result(
    'mode-frequencies',
    'Mode frequencies vs analytic rectangle',
    'within 1% below fs/8',
    `worst ${(worst * 100).toFixed(3)}% across ${rows.length} isolated modes up to ${limit} Hz`,
    worst < 0.01 && rows.length >= 5,
    { rows },
  );
}

// A one-dimensional duct: three open rows between rigid walls, excited uniformly across,
// so it carries a plane wave. Long enough that the pulse parts arrive separately.
function ductRun({ build, steps, sensors, pulseAt = 400, width = 12, length = 3200, airSigma = 0 }) {
  const ny = 5;
  const grid = blankGrid(length, ny, AIR);
  build(grid, length);
  const compiled = compileGrid(grid, length, ny, { rate: RATE, borderMaterial: MIRROR, airSigma });
  const solver = new ReferenceSolver(compiled);
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < length - 1; x += 1) {
      if (compiled.flags[y * length + x] & FLAG_SOLID) continue;
      const v = Math.exp(-((x - pulseAt) ** 2) / (2 * width * width));
      solver.cur[y * length + x] = v;
      solver.prev[y * length + x] = v;
    }
  }
  const traces = sensors.map(() => new Float64Array(steps));
  for (let n = 0; n < steps; n += 1) {
    solver.step();
    for (let s = 0; s < sensors.length; s += 1) traces[s][n] = solver.cur[2 * length + sensors[s]];
  }
  return { traces, compiled };
}

function travelSteps(cells, lambda2 = LAMBDA2) {
  return Math.round(cells / Math.sqrt(lambda2));
}

function windowAround(center, half = 110) {
  return [Math.max(0, center - half), center + half];
}

// Reflection from a wall placed `wallAt` cells along the duct.
function measureWallReflection(material, wallAt = 900, sensor = 600, pulseAt = 400) {
  const { traces } = ductRun({
    build: (grid, nx) => { for (let y = 0; y < 5; y += 1) grid[y * nx + wallAt] = material; },
    steps: travelSteps(1100),
    sensors: [sensor],
    pulseAt,
  });
  const [trace] = traces;
  const incident = peakIn(trace, ...windowAround(travelSteps(sensor - pulseAt)));
  const reflected = peakIn(trace, ...windowAround(travelSteps(wallAt - pulseAt + wallAt - sensor)));
  return reflected / incident;
}

export function checkWallAbsorption() {
  const rows = [STONE, WOOD].map((id) => {
    const { beta, label } = MATERIALS[id];
    const expected = 1 - wallReflection(beta) ** 2;
    const measured = 1 - measureWallReflection(id) ** 2;
    return { material: label, beta, expected, measured, error: Math.abs(measured - expected) / expected };
  });
  const worst = Math.max(...rows.map((r) => r.error));
  return result(
    'wall-absorption',
    'Wall absorption vs admittance, normal incidence',
    'within 10%',
    `worst ${(worst * 100).toFixed(2)}%`,
    worst < 0.1,
    { rows },
  );
}

export function checkInterface() {
  const interfaceAt = 900;
  const material = MATERIALS[HEAVY_GAS];
  const z2 = material.rho * material.c;
  const sensorBefore = 600;
  const sensorAfter = 1100;
  const steps = travelSteps(1100);
  const { traces } = ductRun({
    build: (grid, nx) => {
      for (let y = 0; y < 5; y += 1) {
        for (let x = interfaceAt; x < nx; x += 1) grid[y * nx + x] = HEAVY_GAS;
      }
    },
    steps,
    sensors: [sensorBefore, sensorAfter],
  });
  const incidentAt = travelSteps(sensorBefore - 400);
  const reflectedAt = travelSteps(interfaceAt - 400 + interfaceAt - sensorBefore);
  const incident = peakIn(traces[0], ...windowAround(incidentAt));
  const reflected = peakIn(traces[0], ...windowAround(reflectedAt));
  const transmitted = peakIn(traces[1]);
  const measuredR = reflected / incident;
  const measuredT = transmitted / incident;
  const expectedR = pressureReflection(1, z2);
  const expectedT = pressureTransmission(1, z2);
  const errorR = Math.abs(measuredR - expectedR) / expectedR;
  const errorT = Math.abs(measuredT - expectedT) / expectedT;
  return result(
    'interface',
    'Air to heavy gas: reflection and transmission vs theory',
    'within 5%',
    `R ${measuredR.toFixed(4)} (theory ${expectedR.toFixed(4)}), T ${measuredT.toFixed(4)} (theory ${expectedT.toFixed(4)})`,
    errorR < 0.05 && errorT < 0.05,
    { measuredR, expectedR, measuredT, expectedT, errorR, errorT },
  );
}

function bandRatio(specA, specB, frequency) {
  const bin = Math.round(frequency / specA.binHz);
  return specA.magnitude[bin] / specB.magnitude[bin];
}

// Glass only earns its name if transmission falls the way the mass law says it should.
export function checkMassLaw() {
  // The sheet rings for several milliseconds, so the window must outlast that tail.
  // Positions keep the end-wall reflections out of the window.
  const pulseAt = 1400;
  const sheetAt = 1900;
  const sensor = 2100;
  const steps = travelSteps(2700);
  const run = (material) => ductRun({
    build: (grid, nx) => {
      if (material !== AIR) for (let y = 0; y < 5; y += 1) grid[y * nx + sheetAt] = material;
    },
    steps,
    sensors: [sensor],
    pulseAt,
    width: 3,
  }).traces[0];
  const withSheet = spectrum(run(GLASS), RATE, { window: false, padTo: 16384 });
  const open = spectrum(run(AIR), RATE, { window: false, padTo: 16384 });
  const { surfaceDensity } = MATERIALS[GLASS];
  const rows = [125, 250, 500, 1000, 2000].map((frequency) => {
    const measured = db(bandRatio(withSheet, open, frequency));
    const expected = db(massLawTransmission(frequency, surfaceDensity));
    return { frequency, measuredDb: measured, expectedDb: expected, errorDb: Math.abs(measured - expected) };
  });
  const worst = Math.max(...rows.map((r) => r.errorDb));
  const slope = rows[rows.length - 1].measuredDb - rows[rows.length - 2].measuredDb;
  return result(
    'mass-law',
    'Glass sheet transmission vs mass law',
    'within 3 dB from 125 Hz to 2 kHz; about -6 dB per octave',
    `worst ${worst.toFixed(2)} dB, last octave ${slope.toFixed(2)} dB`,
    worst < 3 && slope < -4.5 && slope > -7.5,
    { rows },
  );
}

// Foam on a rigid backing: absorption should rise with frequency from the physics alone.
export function checkFoamAbsorption({ depthCells = 12 } = {}) {
  // Positions keep the reflection from the far end of the duct out of the window.
  const wallAt = 1900;
  const sensor = 1600;
  const pulseAt = 1400;
  const width = 3;
  const steps = travelSteps(1500);
  const reflection = (withFoam) => {
    const { traces } = ductRun({
      build: (grid, nx) => {
        for (let y = 0; y < 5; y += 1) {
          grid[y * nx + wallAt] = MIRROR;
          if (withFoam) for (let d = 1; d <= depthCells; d += 1) grid[y * nx + wallAt - d] = FOAM;
        }
      },
      steps,
      sensors: [sensor],
      pulseAt,
      width,
    });
    const start = travelSteps(wallAt - depthCells - pulseAt + wallAt - depthCells - sensor) - 150;
    return traces[0].subarray(start, Math.min(steps, start + 700));
  };
  const hard = spectrum(reflection(false), RATE, { window: false, padTo: 8192 });
  const soft = spectrum(reflection(true), RATE, { window: false, padTo: 8192 });
  const rows = [125, 250, 500, 1000, 2000].map((frequency) => {
    const ratio = bandRatio(soft, hard, frequency);
    return { frequency, absorption: Math.max(0, 1 - ratio * ratio) };
  });
  const low = rows[0].absorption;
  const high = rows[rows.length - 1].absorption;
  return result(
    'foam-absorption',
    `Foam (${depthCells} cells deep) absorbs highs more than lows`,
    'absorption at 2 kHz above absorption at 125 Hz',
    `${(low * 100).toFixed(1)}% at 125 Hz, ${(high * 100).toFixed(1)}% at 2 kHz`,
    high > low,
    { rows },
  );
}

// A random room: cells of every material, and a noise burst to excite everything.
export function checkRandomRooms({ rooms = 20, steps = 30000, nx = 120, ny = 80 } = {}) {
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const palette = [STONE, WOOD, FOAM, GLASS, HEAVY_GAS, MIRROR];
  let worstEigen = 0;
  let worstPeak = 0;
  let energyRises = 0;
  let nonFinite = 0;
  for (let r = 0; r < rooms; r += 1) {
    const grid = blankGrid(nx, ny, AIR);
    const shapes = 6 + Math.floor(random() * 25);
    for (let s = 0; s < shapes; s += 1) {
      const material = palette[Math.floor(random() * palette.length)];
      const x0 = 1 + Math.floor(random() * (nx - 3));
      const y0 = 1 + Math.floor(random() * (ny - 3));
      const thin = random() < 0.5;
      const w = thin ? 1 : 1 + Math.floor(random() * 20);
      const h = thin ? 1 + Math.floor(random() * 30) : 1 + Math.floor(random() * 20);
      fillRect(grid, nx, x0, y0, Math.min(nx - 2, x0 + w), Math.min(ny - 2, y0 + h), material);
    }
    const compiled = compileGrid(grid, nx, ny, { rate: RATE, airSigma: random() < 0.5 ? 0 : 2 });
    worstEigen = Math.max(worstEigen, operatorEigenvalue(compiled, 300, r + 1));
    const solver = new ReferenceSolver(compiled);
    for (let i = 0; i < 400; i += 1) {
      const x = 2 + random() * (nx - 5);
      const y = 2 + random() * (ny - 5);
      solver.inject(x, y, random() - 0.5);
    }
    let previous = solver.energy();
    const startEnergy = previous;
    for (let block = 0; block < 10; block += 1) {
      solver.run(Math.floor(steps / 10));
      const e = solver.energy();
      if (!Number.isFinite(e)) {
        nonFinite += 1;
        break;
      }
      if (e > previous * (1 + 1e-4) && e > startEnergy * 1e-6) energyRises += 1;
      previous = e;
    }
    worstPeak = Math.max(worstPeak, solver.peak());
  }
  const limit = LAMBDA2 * worstEigen;
  return result(
    'random-rooms',
    `Random rooms of every material (${rooms} rooms, ${steps.toLocaleString('en-US')} steps each)`,
    'no blow-up, no NaN, energy never rises, stability bound below 4',
    `bound ${limit.toFixed(4)} of 4, final peak ${worstPeak.toFixed(4)}, ${energyRises} rises, ${nonFinite} non-finite`,
    nonFinite === 0 && energyRises === 0 && limit <= 4 && worstEigen <= MAX_OPERATOR_EIGENVALUE * 1.001,
    { worstEigen, worstPeak, energyRises, nonFinite },
  );
}

// A tone source moving straight at, then straight away from, two fixed microphones.
export function checkDoppler({ frequency = 1000, speed = 34.3, nx = 900, ny = 220 } = {}) {
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, {
    rate: RATE,
    borderMaterial: MIRROR,
    sponge: { width: 40, maxSigma: 2400 },
  });
  const solver = new ReferenceSolver(compiled);
  const cellsPerStep = (speed * compiled.dt) / compiled.dx;
  const startX = 300;
  const y = ny / 2;
  const steps = 5200;
  const ahead = new Float64Array(steps);
  const behind = new Float64Array(steps);
  const aheadX = 780;
  const behindX = 90;
  let last = 0;
  for (let n = 0; n < steps; n += 1) {
    const value = Math.sin(2 * Math.PI * frequency * n * compiled.dt);
    solver.step();
    solver.inject(startX + cellsPerStep * n, y, value - last);
    last = value;
    ahead[n] = solver.sample(aheadX, y);
    behind[n] = solver.sample(behindX, y);
  }
  const measure = (trace) => {
    const part = trace.subarray(2800, steps);
    return peakFrequency(spectrum(part, RATE, { padTo: 32768 }), frequency * 0.7, frequency * 1.4).frequency;
  };
  const expectedAhead = frequency / (1 - speed / C_AIR);
  const expectedBehind = frequency / (1 + speed / C_AIR);
  const measuredAhead = measure(ahead);
  const measuredBehind = measure(behind);
  const errorAhead = Math.abs(measuredAhead - expectedAhead) / expectedAhead;
  const errorBehind = Math.abs(measuredBehind - expectedBehind) / expectedBehind;
  return result(
    'doppler',
    `Doppler shift, ${frequency} Hz source at ${speed} m/s`,
    'within 1%',
    `ahead ${measuredAhead.toFixed(1)} Hz (theory ${expectedAhead.toFixed(1)}), behind ${measuredBehind.toFixed(1)} Hz (theory ${expectedBehind.toFixed(1)})`,
    errorAhead < 0.01 && errorBehind < 0.01,
    { errorAhead, errorBehind, measuredAhead, measuredBehind },
  );
}

export function checkReversal({ steps = 20000, nx = 160, ny = 96 } = {}) {
  const solver = new ReferenceSolver(irregularLosslessRoom(nx, ny));
  setGaussian(solver, nx * 0.2, ny * 0.5, 2.5);
  const original = Float32Array.from(solver.cur);
  solver.run(steps);
  const spreadPeak = solver.peak();
  solver.reverse();
  solver.run(steps);
  // After n forward and n backward steps the newest state is the one before the start.
  let residual = 0;
  let reference = 0;
  for (let i = 0; i < original.length; i += 1) {
    residual += (solver.prev[i] - original[i]) ** 2;
    reference += original[i] ** 2;
  }
  const errorDb = 10 * Math.log10(residual / reference + 1e-30);
  return result(
    'time-reversal',
    `Time reversal returns to the start after ${steps.toLocaleString('en-US')} steps`,
    'under -60 dB residual',
    `${errorDb.toFixed(1)} dB`,
    errorDb < -60,
    { errorDb, spreadPeak },
  );
}

export function checkSponge() {
  const length = 2000;
  const { traces } = ductRun({
    length,
    build: () => {},
    steps: travelSteps(600),
    sensors: [700],
    pulseAt: 500,
    width: 6,
  });
  const direct = peakIn(traces[0]);
  const open = (() => {
    const ny = 5;
    const nx = 1100;
    const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, {
      rate: RATE, borderMaterial: MIRROR, sponge: { width: 40, maxSigma: 2400 },
    });
    const solver = new ReferenceSolver(compiled);
    for (let y = 1; y < ny - 1; y += 1) {
      for (let x = 45; x < nx - 45; x += 1) {
        const v = Math.exp(-((x - 500) ** 2) / (2 * 6 * 6));
        solver.cur[y * nx + x] = v;
        solver.prev[y * nx + x] = v;
      }
    }
    const steps = travelSteps(1300);
    const trace = new Float64Array(steps);
    for (let n = 0; n < steps; n += 1) {
      solver.step();
      trace[n] = solver.cur[2 * nx + 700];
    }
    // Wait until both outgoing halves have passed, then look for anything returning.
    return peakIn(trace, travelSteps(300));
  })();
  const reflectionDb = db(open / direct);
  return result(
    'sponge',
    'Open edge reflection (sponge)',
    'under -30 dB',
    `${reflectionDb.toFixed(1)} dB`,
    reflectionDb < -30,
    { reflectionDb },
  );
}

// A door between two rooms: the same tone, measured beyond it, with the door open and shut.
export function checkDoor() {
  const measure = (open) => {
    const room = addObject(addObject(addObject(createRoom({
      width: 7, height: 4, ear: { x: 6.5, y: 3.5, angle: 0 }, airLoss: 6,
    }), {
      type: 'wall', points: [{ x: 3.5, y: 0 }, { x: 3.5, y: 1.5 }], thickness: 0.3, material: 'stone',
    }), {
      type: 'wall', points: [{ x: 3.5, y: 2.5 }, { x: 3.5, y: 4 }], thickness: 0.3, material: 'stone',
    }), {
      type: 'door', hinge: { x: 3.5, y: 1.5 }, length: 1, angle: Math.PI / 2, swing: Math.PI / 2, open, thickness: 0.15, frame: 0.4, material: 'stone',
    });
    const raster = rasterise(room, RATE);
    const compiled = compileGrid(raster.grid, raster.nx, raster.ny, compileOptionsFor(room, RATE, raster.margin));
    const solver = new ReferenceSolver(compiled);
    const source = toCell({ x: 1.5, y: 2 }, raster);
    const mic = toCell({ x: 5.5, y: 2 }, raster);
    const steps = 9000;
    let power = 0;
    let last = 0;
    for (let n = 0; n < steps; n += 1) {
      const value = Math.sin((2 * Math.PI * 1000 * n) / RATE);
      solver.step();
      solver.inject(source.x, source.y, value - last);
      last = value;
      if (n > steps / 2) power += solver.sample(mic.x, mic.y) ** 2;
    }
    return { rms: Math.sqrt(power / (steps / 2)), compiled, changed: raster.grid };
  };
  const open = measure(1);
  const shut = measure(0);
  const difference = shut.rms > 0 ? db(open.rms / shut.rms) : Infinity;
  return result(
    'door',
    'A door changes what gets through: 1 kHz tone beyond it, open vs shut',
    'at least 20 dB',
    `${difference.toFixed(1)} dB`,
    difference >= 20,
    { openRms: open.rms, shutRms: shut.rms, difference },
  );
}

// Two equal tones, equidistant from a microphone in open air.
export function checkInterference({ frequency = 800 } = {}) {
  const nx = 340;
  const ny = 260;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, {
    rate: RATE, borderMaterial: MIRROR, sponge: { width: 40, maxSigma: 2400 },
  });
  const mic = { x: 170, y: 130 };
  const separation = 45;
  const run = (phaseB, onlyA = false) => {
    const solver = new ReferenceSolver(compiled);
    const steps = 3600;
    let power = 0;
    let lastA = 0;
    let lastB = 0;
    for (let n = 0; n < steps; n += 1) {
      const a = Math.sin((2 * Math.PI * frequency * n) / RATE);
      const b = onlyA ? 0 : Math.sin((2 * Math.PI * frequency * n) / RATE + phaseB);
      solver.step();
      solver.inject(mic.x - separation, mic.y, a - lastA);
      solver.inject(mic.x + separation, mic.y, b - lastB);
      lastA = a;
      lastB = b;
      if (n > steps / 2) power += solver.cur[mic.y * nx + mic.x] ** 2;
    }
    return Math.sqrt(power / (steps / 2));
  };
  const single = run(0, true);
  const inPhase = run(0);
  const antiPhase = run(Math.PI);
  const nullDb = db(antiPhase / single);
  const boostDb = db(inPhase / single);
  return result(
    'interference',
    'Two equal sources at an equidistant point',
    'anti-phase null of at least 30 dB; in-phase about +6 dB',
    `anti-phase ${nullDb.toFixed(1)} dB, in-phase ${boostDb >= 0 ? '+' : ''}${boostDb.toFixed(2)} dB, against one source alone`,
    nullDb <= -30 && Math.abs(boostDb - 6.02) < 1,
    { nullDb, boostDb },
  );
}

// Adding absorption must never lengthen a room's decay, in any band. Regression: an impulse
// used to excite waves near the grid cutoff, which were trapped and rang on as a false tail.
export function checkNoNumericalTail() {
  const rate = 8000;
  const source = { x: 1.2, y: 1 };
  const mic = { x: 4.6, y: 2.9 };
  const foam = (room, d) => [
    { x: 3, y: d / 2, w: 6, h: d },
    { x: 3, y: 4 - d / 2, w: 6, h: d },
    { x: d / 2, y: 2, w: d, h: 4 },
    { x: 6 - d / 2, y: 2, w: d, h: 4 },
  ].reduce((r, shape) => addObject(r, { type: 'rect', material: 'foam', ...shape }), room);
  const decayOf = (room) => {
    const { traces } = bakeCpu({
      room, sources: [{ point: source, stimulus: { kind: 'impulse' } }], listeners: [mic], seconds: 3.5, rate,
    });
    return decayTime(throughChain(traces[0], rate), rate);
  };
  const bare = createRoom({ width: 6, height: 4, airLoss: 0.5, ear: { x: 5.5, y: 3.5, angle: 0 } });
  const untreated = decayOf(bare);
  const treated = decayOf(foam(bare, 0.4));
  return result(
    'numerical-tail',
    'Foam on every wall shortens the decay',
    'decay falls by at least half',
    `${untreated?.toFixed(2)} s bare, ${treated?.toFixed(2)} s with foam`,
    untreated !== null && treated !== null && treated < untreated / 2,
    { untreated, treated },
  );
}

// A painted reed in a drawn pipe has no pitch of its own. Blown, it should settle on the
// resonance the same pipe shows when simply struck, and move when the pipe changes length.
export function checkReedPlaysPipe() {
  const pipe = (length, withReed) => {
    const half = 0.08;
    const x0 = 0.5;
    const wall = (points) => ({ type: 'wall', points, thickness: 0.04, material: 'mirror' });
    let room = createRoom({ width: 3.2, height: 2, edges: 'open', airLoss: 0.8, ear: { x: 2.9, y: 1.7, angle: Math.PI } });
    room = addObject(room, wall([{ x: x0, y: 1 - half }, { x: x0 + length, y: 1 - half }]));
    room = addObject(room, wall([{ x: x0, y: 1 + half }, { x: x0 + length, y: 1 + half }]));
    room = addObject(room, {
      type: 'wall', points: [{ x: x0 - 0.07, y: 1 - half }, { x: x0 - 0.07, y: 1 + half }], thickness: 0.14, material: 'mirror',
    });
    // Filling the bore and hard against the closed end. A gap behind it would be a tiny
    // resonator of its own, and a narrower reed's strength would change with the grid.
    if (withReed) room = addObject(room, { type: 'rect', x: x0 + 0.1, y: 1, w: 0.2, h: half * 2, material: 'reed' });
    return room;
  };
  const trace = (rate, length, withReed, seed = 7) => {
    const room = pipe(length, withReed);
    const raster = rasterise(room, rate);
    const compiled = compileGrid(raster.grid, raster.nx, raster.ny, compileOptionsFor(room, rate, raster.margin));
    const solver = new ReferenceSolver(compiled, { reedGain: withReed ? 160 / rate : 0, reedLevel: 0.25 });
    const start = toCell({ x: 0.5 + length / 2, y: 1 }, raster);
    const mic = toCell({ x: 0.5 + length * 0.3, y: 1 }, raster);
    const steps = Math.round(rate * 1.6);
    const out = new Float32Array(steps);
    let state = seed;
    for (let n = 0; n < steps; n += 1) {
      solver.step();
      if (withReed && n < rate * 0.2) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        solver.inject(start.x, start.y, (state / 2 ** 31 - 1) * 0.002);
      } else if (!withReed && n < 2) {
        solver.inject(start.x, start.y, n === 0 ? 1 : -1);
      }
      out[n] = solver.sample(mic.x, mic.y);
    }
    return out;
  };
  const strongest = (rate, signal, from, top) => {
    const part = signal.subarray(from);
    const mean = part.reduce((s, v) => s + v, 0) / part.length;
    return peakFrequency(spectrum(part.map((v) => v - mean), rate, { padTo: 65536 }), 25, top).frequency;
  };
  // Every rate the app can run at, and more than one starting noise: which mode wins can depend
  // on the noise, so one seed passing at two rates proved nothing about the rest.
  const rates = [8000, 11025, 16000, 22050];
  const seeds = [7, 1234567];
  const rows = rates.flatMap((rate) => [1.4, 1, 0.6].flatMap((length) => {
    // The fundamental of a pipe this size is well below 300 Hz. The blown note gets the whole
    // band to choose from, so a reed that picks the wrong mode is caught rather than excused.
    const struck = strongest(rate, trace(rate, length, false), 0, 300);
    return seeds.map((seed) => {
      const blownTrace = trace(rate, length, true, seed);
      const blown = strongest(rate, blownTrace, rate, rate * 0.25);
      return {
        rate,
        length,
        seed,
        struck,
        blown,
        ratio: blown / struck,
        // Below this it isn't playing: what's left is noise, and its "pitch" means nothing.
        levelDb: db(rmsOf(blownTrace, rate)),
      };
    });
  }));
  const playing = rows.every((r) => r.levelDb > -30);
  const inTune = rows.every((r) => r.ratio > 0.9 && r.ratio < 1.1);
  const rising = rates.every((rate) => seeds.every((seed) => {
    const [a, b, c] = rows.filter((r) => r.rate === rate && r.seed === seed);
    return b.blown > a.blown && c.blown > b.blown && c.blown / a.blown > 1.4;
  }));
  return result(
    'reed',
    'A reed plays the note of the pipe it sits in, at every rate, whatever noise starts it',
    'audibly playing; within 10% of the struck pipe; more than 1.4x higher in the shortest pipe',
    rows.filter((r) => r.seed === seeds[0]).map((r) => {
      const other = rows.find((o) => o.rate === r.rate && o.length === r.length && o.seed !== r.seed);
      return `${r.rate / 1000}k ${r.length} m: ${r.blown.toFixed(1)}/${other.blown.toFixed(1)} Hz (${r.ratio.toFixed(2)}/${other.ratio.toFixed(2)}x struck ${r.struck.toFixed(1)}), ${r.levelDb.toFixed(0)} dB`;
    }).join('; '),
    playing && inTune && rising,
    { rows, playing, inTune, rising },
  );
}

function rmsOf(signal, from) {
  let sum = 0;
  for (let i = from; i < signal.length; i += 1) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, signal.length - from));
}

export const ALL_CHECKS = Object.freeze({
  checkReedPlaysPipe,
  checkNoNumericalTail,
  checkDoor,
  checkInterference,
  checkEnergy,
  checkStabilityMargin,
  checkConstantDrift,
  checkModes,
  checkWallAbsorption,
  checkInterface,
  checkMassLaw,
  checkFoamAbsorption,
  checkRandomRooms,
  checkDoppler,
  checkReversal,
  checkSponge,
});
