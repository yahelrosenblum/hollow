// Turns a grid of material ids into the per-cell coefficients the solver runs on.
// This is the only place materials become numbers.

import {
  FLAG_REED, FLAG_SLOW, FLAG_SOLID, LAMBDA2, MASK_ALL_OPEN, MAX_OPERATOR_EIGENVALUE,
  MIRROR_SHIFT, NEIGHBOURS, cellSizeFor, timeStepFor,
} from './numerics.js';
import { MATERIALS, RHO_AIR, STONE, isWall } from './materials.js';

// m, 1 / (1 + g), k, viscous. The reciprocal is stored because WGSL only promises 2.5 ULP
// on division, and this value is used on every step of every cell near a boundary.
export const COEF_STRIDE = 4;

const UNIT = 1;
const SPONGE_MARGIN_CELLS = 2;

// Keeps the explicit viscous term inside its stability limit at any simulation rate:
// (lambda^2 k + 2 N) m * eigenvalue must stay at or below 4.
function viscousLimit(m, k, lambda2) {
  return Math.max(0, ((4 / (MAX_OPERATOR_EIGENVALUE * m)) - lambda2 * k) / 2);
}

function mediumOf(material, dx, dt, lambda2) {
  if (material.kind === 'sheet') {
    // A stiff cell: a soft one would add its own compliance and turn the mass law into a
    // third-order filter. An isolated sheet cell has eigenvalue up to 6.67 m*k, which must
    // stay under the 5.33 limit, so m*k has to be below 0.81.
    const k = (RHO_AIR * dx) / material.surfaceDensity;
    return { m: 0.75 / k, k, sigma: 0, viscous: 0 };
  }
  const m = material.rho * material.c * material.c;
  const k = 1 / material.rho;
  const wanted = material.diffusivity ? (material.diffusivity * dt) / (dx * dx * m) : 0;
  return {
    m,
    k,
    sigma: material.sigma,
    viscous: Math.min(wanted, viscousLimit(m, k, lambda2)),
  };
}

// The outermost ring of cells is always solid, so the solver never reads out of bounds.
function withSolidBorder(source, nx, ny, borderMaterial) {
  const material = Uint8Array.from(source);
  for (let x = 0; x < nx; x += 1) {
    material[x] = borderMaterial;
    material[(ny - 1) * nx + x] = borderMaterial;
  }
  for (let y = 0; y < ny; y += 1) {
    material[y * nx] = borderMaterial;
    material[y * nx + nx - 1] = borderMaterial;
  }
  return material;
}

// Sponge: damping that ramps up quadratically toward an open edge.
function spongeProfile(nx, ny, width, maxSigma) {
  const sigma = new Float32Array(nx * ny);
  if (width <= 0) return sigma;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const edge = Math.min(x, y, nx - 1 - x, ny - 1 - y);
      if (edge < width) {
        const t = (width - edge) / width;
        sigma[y * nx + x] = maxSigma * t * t;
      }
    }
  }
  return sigma;
}

// How many diagonals reflect onto axial edge n of cell i. A side counts only when the wall
// covers both ends of the edge, which keeps the operator symmetric.
function mirrorCount(material, i, nx, n) {
  const [ox, oy] = NEIGHBOURS[n];
  const j = i + oy * nx + ox;
  if (isWall(material[j])) return 0;
  const sideA = ox !== 0 ? -nx : -1;
  const sideB = ox !== 0 ? nx : 1;
  let count = 0;
  if (isWall(material[i + sideA]) && isWall(material[j + sideA])) count += 1;
  if (isWall(material[i + sideB]) && isWall(material[j + sideB])) count += 1;
  return count;
}

// Whether an edge is closed, and the admittance a wave meets when it reflects off it.
// A diagonal mirrors across whichever wall it hits, or both in an inside corner, so a flat
// wall of admittance beta always charges each adjacent cell a total of exactly beta.
function edgeBoundary(material, i, j, ox, oy, nx) {
  const targetSolid = isWall(material[j]);
  if (ox === 0 || oy === 0) {
    return { blocked: targetSolid, beta: targetSolid ? MATERIALS[material[j]].beta : 0 };
  }
  const a = material[i + ox];
  const b = material[i + oy * nx];
  const solidA = isWall(a);
  const solidB = isWall(b);
  // A diagonal may not squeeze between two solid cells that touch at a corner.
  if (!targetSolid && !(solidA && solidB)) return { blocked: false, beta: 0 };
  if (!solidA && !solidB) return { blocked: true, beta: MATERIALS[material[j]].beta };
  const beta = (solidA ? MATERIALS[a].beta : 0) + (solidB ? MATERIALS[b].beta : 0);
  return { blocked: true, beta };
}

function compileCell(compiled, i) {
  const {
    material, flags, coef, media, nx, lambda, dt, g0, spongeSigma,
  } = compiled;
  const c = i * COEF_STRIDE;
  if (isWall(material[i])) {
    flags[i] = FLAG_SOLID;
    coef[c] = 0;
    coef[c + 1] = 1;
    coef[c + 2] = 0;
    coef[c + 3] = 0;
    return;
  }
  const mat = MATERIALS[material[i]];
  const medium = media[material[i]];

  let mask = 0;
  let boundaryLoss = 0;
  let uniformNeighbours = true;
  for (let n = 0; n < NEIGHBOURS.length; n += 1) {
    const [ox, oy, weight] = NEIGHBOURS[n];
    const j = i + oy * nx + ox;
    const { blocked, beta } = edgeBoundary(material, i, j, ox, oy, nx);
    if (blocked) {
      boundaryLoss += weight * beta;
    } else {
      mask |= 1 << n;
      if (media[material[j]].k !== medium.k || media[material[j]].viscous !== medium.viscous) {
        uniformNeighbours = false;
      }
    }
  }

  let mirrors = 0;
  for (let n = 0; n < 4; n += 1) {
    mirrors |= mirrorCount(material, i, nx, n) << (MIRROR_SHIFT + 2 * n);
  }

  const g = g0 + (medium.sigma + spongeSigma[i]) * dt + (lambda / 2) * boundaryLoss;
  const isPlain = mask === MASK_ALL_OPEN && uniformNeighbours && medium.viscous === 0
    && medium.k === UNIT && medium.m === UNIT && g === g0 && !mat.reed;

  flags[i] = mask | mirrors | (isPlain ? 0 : FLAG_SLOW) | (mat.reed ? FLAG_REED : 0);
  coef[c] = medium.m;
  coef[c + 1] = 1 / (1 + g);
  coef[c + 2] = medium.k;
  coef[c + 3] = medium.viscous;
}

export function compileGrid(source, nx, ny, options = {}) {
  const {
    rate = 16000,
    lambda2 = LAMBDA2,
    airSigma = 0,
    sponge = null,
    borderMaterial = STONE,
  } = options;
  if (source.length !== nx * ny) {
    throw new RangeError(`grid has ${source.length} cells, expected ${nx * ny}`);
  }

  const dt = timeStepFor(rate);
  const dx = cellSizeFor(rate, lambda2);
  const material = withSolidBorder(source, nx, ny, borderMaterial);
  const count = nx * ny;
  const compiled = {
    nx,
    ny,
    rate,
    dt,
    dx,
    lambda2,
    lambda: Math.sqrt(lambda2),
    g0: airSigma * dt,
    borderMaterial,
    flags: new Uint32Array(count),
    coef: new Float32Array(count * COEF_STRIDE),
    material,
    media: MATERIALS.map((m) => (m.kind === 'wall' ? null : mediumOf(m, dx, dt, lambda2))),
    spongeSigma: sponge ? spongeProfile(nx, ny, sponge.width, sponge.maxSigma) : new Float32Array(count),
  };
  for (let i = 0; i < count; i += 1) compileCell(compiled, i);
  return compiled;
}

// Applies a new material grid to an already compiled one, recompiling only what changed.
// Returns the changed rectangle of cells, or null if nothing changed.
export function updateGrid(compiled, source) {
  const { nx, ny, material, borderMaterial } = compiled;
  const next = withSolidBorder(source, nx, ny, borderMaterial);
  let x0 = nx;
  let y0 = ny;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = y * nx + x;
      if (material[i] !== next[i]) {
        material[i] = next[i];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  // A cell's coefficients depend on neighbours up to two away, through the mirror rule.
  const rect = {
    x0: Math.max(0, x0 - SPONGE_MARGIN_CELLS),
    y0: Math.max(0, y0 - SPONGE_MARGIN_CELLS),
    x1: Math.min(nx - 1, x1 + SPONGE_MARGIN_CELLS),
    y1: Math.min(ny - 1, y1 + SPONGE_MARGIN_CELLS),
  };
  for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      const i = y * nx + x;
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) {
        flags_markSolid(compiled, i);
      } else {
        compileCell(compiled, i);
      }
    }
  }
  return rect;
}

function flags_markSolid(compiled, i) {
  compiled.flags[i] = FLAG_SOLID;
}

// Fills a whole grid with one material, leaving the caller to carve shapes into it.
export function blankGrid(nx, ny, fill = 0) {
  return new Uint8Array(nx * ny).fill(fill);
}
