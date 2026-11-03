// Room objects to a grid of material ids. Runs on every edit, in the worker.

import { cellSizeFor } from '../sim/numerics.js';
import {
  AIR, DOOR_LEAF, HEAD, MATERIALS, MIRROR, STONE,
} from '../sim/materials.js';
import {
  HEAD_RADIUS, doorLeaf, objectBounds, paintPieces, signedDistance,
} from './room.js';

const MATERIAL_BY_KEY = new Map(MATERIALS.map((m) => [m.key, m.id]));
const SPONGE_METRES = 0.9;
const SPONGE_SIGMA = 2400;

function isSolidCell(id) {
  return MATERIALS[id].kind !== 'fluid';
}

export function materialId(key) {
  const id = MATERIAL_BY_KEY.get(key);
  if (id === undefined) throw new RangeError(`unknown material "${key}"`);
  return id;
}

export function gridSizeFor(room, rate) {
  const dx = cellSizeFor(rate);
  const margin = room.edges === 'open' ? Math.round(SPONGE_METRES / dx) : 0;
  return {
    dx,
    margin,
    nx: Math.round(room.width / dx) + 2 + margin * 2,
    ny: Math.round(room.height / dx) + 2 + margin * 2,
  };
}

// Solver coordinates are cell indices, where the centre of cell i is at integer i.
export function toCell(point, { dx, margin }) {
  return { x: point.x / dx + 0.5 + margin, y: point.y / dx + 0.5 + margin };
}

export function toMetres(cell, { dx, margin }) {
  return { x: (cell.x - 0.5 - margin) * dx, y: (cell.y - 0.5 - margin) * dx };
}

// A fluid fills air and never erases a wall or a sheet such as glass or a door: thickened to
// stay unbroken, a reed or foam placed against one would otherwise eat through it, opening holes
// that depend on the grid spacing. Openings and doors carve through walls on purpose, and say so
// by painting AIR.
function paint(grid, size, object, materialIdValue, minimum, { keepWalls = false } = {}) {
  const { nx, ny, dx, margin } = size;
  const b = objectBounds(object);
  const pad = minimum + dx;
  const x0 = Math.max(1, Math.floor((b.x0 - pad) / dx + 0.5 + margin));
  const x1 = Math.min(nx - 2, Math.ceil((b.x1 + pad) / dx + 0.5 + margin));
  const y0 = Math.max(1, Math.floor((b.y0 - pad) / dx + 0.5 + margin));
  const y1 = Math.min(ny - 2, Math.ceil((b.y1 + pad) / dx + 0.5 + margin));
  const point = { x: 0, y: 0 };
  for (let y = y0; y <= y1; y += 1) {
    point.y = (y - 0.5 - margin) * dx;
    for (let x = x0; x <= x1; x += 1) {
      point.x = (x - 0.5 - margin) * dx;
      const i = y * nx + x;
      if (signedDistance(object, point) <= minimum && !(keepWalls && isSolidCell(grid[i]))) grid[i] = materialIdValue;
    }
  }
}

// Thin objects must stay thick enough to be unbroken at this grid's resolution, so that a
// line at any angle has no gap a wave could slip through.
function minimumReach(dx) {
  return dx * 0.72;
}

function paintObject(grid, size, object) {
  const reach = minimumReach(size.dx);
  switch (object.type) {
    case 'opening':
      paint(grid, size, object, AIR, 0);
      break;
    case 'window':
      if (object.open) paint(grid, size, { ...object, type: 'opening', width: object.thickness ?? 0.02 }, AIR, reach);
      else paint(grid, size, object, materialId('glass'), reach);
      break;
    case 'door': {
      // The doorway itself is an opening; the leaf then blocks it or swings out of the way.
      const closedLeaf = doorLeaf({ ...object, open: false });
      paint(grid, size, { type: 'opening', a: closedLeaf.a, b: closedLeaf.b, width: object.frame ?? 0.5 }, AIR, 0);
      paint(grid, size, object, DOOR_LEAF, reach);
      break;
    }
    default: {
      const id = materialId(object.material);
      const keepWalls = MATERIALS[id].kind === 'fluid';
      for (const piece of paintPieces(object)) paint(grid, size, piece, id, reach, { keepWalls });
      break;
    }
  }
}

// The head absorbs a little, so in a lossless room it has to reflect perfectly instead:
// a single lossy object would stop time from running backward.
function paintHead(grid, size, ear, lossless) {
  const material = lossless ? MIRROR : HEAD;
  paint(grid, size, { type: 'ellipse', x: ear.x, y: ear.y, rx: HEAD_RADIUS, ry: HEAD_RADIUS, thickness: 0 }, material, 0);
}

export function rasterise(room, rate) {
  const size = gridSizeFor(room, rate);
  const grid = new Uint8Array(size.nx * size.ny);
  for (const object of room.objects) paintObject(grid, size, object);
  paintHead(grid, size, room.ear, room.lossless === true);
  return { grid, ...size };
}

export function compileOptionsFor(room, rate, margin) {
  const lossless = room.lossless === true;
  return {
    rate,
    airSigma: lossless ? 0 : room.airLoss,
    borderMaterial: lossless ? materialId('mirror') : materialId(room.edgeMaterial ?? 'stone') ?? STONE,
    sponge: room.edges === 'open' ? { width: margin, maxSigma: SPONGE_SIGMA } : null,
  };
}
