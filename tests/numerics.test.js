import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankGrid, compileGrid } from '../src/sim/compile.js';
import {
  FLAG_SOLID, LAMBDA2, MAX_OPERATOR_EIGENVALUE, MIRROR_MASK, MIRROR_SHIFT, NEIGHBOURS, edgeWeight,
} from '../src/sim/numerics.js';
import { AIR, FOAM, GLASS, HEAVY_GAS, MIRROR, STONE } from '../src/sim/materials.js';
import { ReferenceSolver, operatorEigenvalue, setGaussian } from '../src/sim/reference.js';

const RATE = 16000;

function rect(grid, nx, x0, y0, x1, y1, material) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) grid[y * nx + x] = material;
  }
}

test('stencil weights sum so that a flat wall charges a cell exactly one unit', () => {
  const total = NEIGHBOURS.reduce((sum, [, , w]) => sum + w, 0);
  assert.ok(Math.abs(total - 10 / 3) < 1e-12);
});

test('rasterised grid always has a solid border', () => {
  const nx = 12;
  const ny = 9;
  const { flags } = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE });
  for (let x = 0; x < nx; x += 1) {
    assert.ok(flags[x] & FLAG_SOLID);
    assert.ok(flags[(ny - 1) * nx + x] & FLAG_SOLID);
  }
  for (let y = 0; y < ny; y += 1) {
    assert.ok(flags[y * nx] & FLAG_SOLID);
    assert.ok(flags[y * nx + nx - 1] & FLAG_SOLID);
  }
});

test('compile rejects a grid of the wrong size', () => {
  assert.throws(() => compileGrid(new Uint8Array(5), 4, 4), RangeError);
});

test('edge weights are symmetric, or the operator would not conserve energy', () => {
  const nx = 50;
  const ny = 40;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 10, 0, 12, 20, STONE);
  rect(grid, nx, 25, 15, 40, 18, STONE);
  for (let d = 0; d < 10; d += 1) grid[(25 + d) * nx + 5 + d] = STONE;
  const { flags } = compileGrid(grid, nx, ny, { rate: RATE });
  const opposite = [1, 0, 3, 2, 7, 6, 5, 4];
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < nx - 1; x += 1) {
      const i = y * nx + x;
      if (flags[i] & FLAG_SOLID) continue;
      for (let n = 0; n < 8; n += 1) {
        if (!(flags[i] & (1 << n))) continue;
        const [ox, oy] = NEIGHBOURS[n];
        const j = (y + oy) * nx + x + ox;
        assert.ok(flags[j] & (1 << opposite[n]), `edge ${i}->${j} is one-way`);
        assert.equal(edgeWeight(flags[i], n), edgeWeight(flags[j], opposite[n]));
      }
    }
  }
});

test('a cell beside a flat wall has the same along-wall conductance as open air', () => {
  // Regression: removing the diagonals without mirroring them gave 5/6 of the conductance,
  // so a wave grazing a wall travelled at the wrong speed and scattered.
  const nx = 20;
  const ny = 20;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 0, 0, nx - 1, 5, STONE);
  const { flags } = compileGrid(grid, nx, ny, { rate: RATE });
  const beside = 6 * nx + 10;
  const east = 0;
  assert.equal((flags[beside] >>> MIRROR_SHIFT) & MIRROR_MASK, 1);
  const alongWall = edgeWeight(flags[beside], east) + (1 / 6); // axial + mirrored + open diagonal
  assert.ok(Math.abs(alongWall - 1) < 1e-12);
});

test('a plane wave stays uniform across a duct', () => {
  // Regression for the same bug, measured rather than inspected.
  const nx = 400;
  const ny = 9;
  const compiled = compileGrid(blankGrid(nx, ny, AIR), nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  for (let y = 1; y < ny - 1; y += 1) {
    for (let x = 1; x < nx - 1; x += 1) {
      const v = Math.exp(-((x - 200) ** 2) / (2 * 8 * 8));
      solver.cur[y * nx + x] = v;
      solver.prev[y * nx + x] = v;
    }
  }
  solver.run(120);
  let worst = 0;
  for (let x = 1; x < nx - 1; x += 1) {
    const middle = solver.cur[4 * nx + x];
    for (let y = 1; y < ny - 1; y += 1) worst = Math.max(worst, Math.abs(solver.cur[y * nx + x] - middle));
  }
  assert.ok(worst < 1e-4, `field varies across the duct by ${worst}`);
});

test('a constant field stays exactly constant', () => {
  // Regression: an expanded update whose 32-bit coefficients do not sum to 2 grows this mode.
  const nx = 40;
  const ny = 30;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 10, 5, 14, 20, MIRROR);
  rect(grid, nx, 22, 8, 28, 14, HEAVY_GAS);
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR, airSigma: 3 });
  for (const strict of [false, true]) {
    const solver = new ReferenceSolver(compiled);
    for (let i = 0; i < nx * ny; i += 1) {
      if (!(compiled.flags[i] & FLAG_SOLID)) {
        solver.cur[i] = 0.3;
        solver.prev[i] = 0.3;
      }
    }
    for (let n = 0; n < 2000; n += 1) {
      if (strict) solver.stepStrict32();
      else solver.step();
    }
    for (let i = 0; i < nx * ny; i += 1) {
      if (!(compiled.flags[i] & FLAG_SOLID)) assert.equal(solver.cur[i], Math.fround(0.3));
    }
  }
});

test('reversing time returns a lossless room to where it started', () => {
  const nx = 80;
  const ny = 50;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 30, 0, 32, 28, MIRROR);
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  setGaussian(solver, 15, 25, 2.5);
  const original = Float32Array.from(solver.cur);
  solver.run(3000);
  solver.reverse();
  solver.run(3000);
  let error = 0;
  let power = 0;
  for (let i = 0; i < original.length; i += 1) {
    error += (solver.prev[i] - original[i]) ** 2;
    power += original[i] ** 2;
  }
  assert.ok(10 * Math.log10(error / power) < -80);
});

test('lossless energy is conserved', () => {
  const nx = 60;
  const ny = 40;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 25, 0, 27, 22, MIRROR);
  rect(grid, nx, 40, 10, 50, 25, HEAVY_GAS);
  rect(grid, nx, 15, 25, 15, 38, GLASS);
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, borderMaterial: MIRROR });
  const solver = new ReferenceSolver(compiled);
  setGaussian(solver, 10, 15, 2);
  const start = solver.energy();
  solver.run(5000);
  assert.ok(Math.abs(solver.energy() - start) / start < 1e-4);
});

test('lossy materials only ever remove energy', () => {
  const nx = 70;
  const ny = 50;
  const grid = blankGrid(nx, ny, AIR);
  rect(grid, nx, 30, 10, 45, 30, FOAM);
  rect(grid, nx, 10, 0, 12, 25, STONE);
  const compiled = compileGrid(grid, nx, ny, { rate: RATE, airSigma: 2 });
  const solver = new ReferenceSolver(compiled);
  setGaussian(solver, 22, 25, 2);
  let previous = solver.energy();
  for (let block = 0; block < 10; block += 1) {
    solver.run(300);
    const e = solver.energy();
    assert.ok(e <= previous * (1 + 1e-6), `energy rose from ${previous} to ${e}`);
    previous = e;
  }
});

test('every material stays inside the stability bound', () => {
  const nx = 60;
  const ny = 40;
  for (const material of [GLASS, FOAM, HEAVY_GAS, STONE]) {
    for (const rate of [11025, 16000, 22050]) {
      const grid = blankGrid(nx, ny, AIR);
      rect(grid, nx, 20, 5, 20, 34, material);
      rect(grid, nx, 30, 5, 34, 34, material);
      grid[20 * nx + 45] = material;
      const compiled = compileGrid(grid, nx, ny, { rate });
      const eigenvalue = operatorEigenvalue(compiled, 500);
      assert.ok(
        compiled.lambda2 * eigenvalue <= 4,
        `material ${material} at ${rate} Hz: bound ${compiled.lambda2 * eigenvalue}`,
      );
    }
  }
});

test('the time step keeps a margin below the full-grid stability limit', () => {
  assert.ok(LAMBDA2 * MAX_OPERATOR_EIGENVALUE < 4);
});
