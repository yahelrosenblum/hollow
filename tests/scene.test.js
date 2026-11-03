import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addObject, createRoom, curvePoints, doorLeaf, duplicateObject, earPositions, objectAt, removeObjects,
  rotateObject, scaleObject, signedDistance, translateObject, updateObject,
} from '../src/scene/room.js';
import { compileOptionsFor, materialId, rasterise, toCell, toMetres } from '../src/scene/rasterise.js';
import { compileGrid, updateGrid } from '../src/sim/compile.js';
import { fitView } from '../src/scene/layout.js';
import { AIR, GLASS, HEAD, STONE } from '../src/sim/materials.js';

const RATE = 16000;

function countOf(grid, id) {
  return grid.reduce((n, v) => n + (v === id ? 1 : 0), 0);
}

test('edits return a new room and leave the old one alone', () => {
  const a = createRoom();
  const b = addObject(a, { type: 'rect', x: 1, y: 1, w: 1, h: 1, material: 'stone' });
  assert.equal(a.objects.length, 0);
  assert.equal(b.objects.length, 1);
  const c = updateObject(b, b.objects[0].id, { w: 2 });
  assert.equal(b.objects[0].w, 1);
  assert.equal(c.objects[0].w, 2);
  assert.equal(removeObjects(c, [c.objects[0].id]).objects.length, 0);
});

test('a room fits inside the part of the field the controls leave uncovered', () => {
  const room = createRoom({ width: 10, height: 5 });
  const inset = { left: 80, right: 360, top: 60, bottom: 0 };
  const view = fitView(room, 1440, 900, 20, inset);
  assert.ok(view.x >= inset.left + 20 - 1e-9, `starts at ${view.x}`);
  assert.ok(view.x + view.width <= 1440 - inset.right - 20 + 1e-9, `ends at ${view.x + view.width}`);
  assert.ok(view.y >= inset.top + 20 - 1e-9);
  // Centred in what's left, not in the window.
  assert.ok(Math.abs(view.x + view.width / 2 - (inset.left + (1440 - inset.left - inset.right) / 2)) < 1e-6);
  // Nothing covered: the same as before insets existed.
  const plain = fitView(room, 1440, 900, 20);
  assert.equal(plain.x, (1440 - plain.width) / 2);
  // Covered completely, it stays a valid shape rather than going negative.
  const squeezed = fitView(room, 400, 300, 20, { left: 500, right: 500, top: 0, bottom: 0 });
  assert.ok(squeezed.width > 0 && squeezed.height > 0 && Number.isFinite(squeezed.x));
});

test('metres and cells convert both ways', () => {
  const size = { dx: 0.025, margin: 10 };
  const p = { x: 3.2, y: 1.7 };
  const back = toMetres(toCell(p, size), size);
  assert.ok(Math.abs(back.x - p.x) < 1e-9);
  assert.ok(Math.abs(back.y - p.y) < 1e-9);
});

test('a wall becomes cells, and an opening carves it', () => {
  const wall = { type: 'wall', points: [{ x: 3, y: 0 }, { x: 3, y: 7 }], thickness: 0.2, material: 'stone' };
  const room = addObject(createRoom({ ear: { x: 9, y: 3, angle: 0 } }), wall);
  const solid = countOf(rasterise(room, RATE).grid, STONE);
  assert.ok(solid > 0);
  const opened = addObject(room, { type: 'opening', a: { x: 3, y: 3 }, b: { x: 3, y: 4 }, width: 0.4 });
  assert.ok(countOf(rasterise(opened, RATE).grid, STONE) < solid);
});

test('a fluid placed against a wall never eats into it, at any rate', () => {
  // Regression: a reed filling a pipe's bore erased the pipe's walls beside it at 11 kHz,
  // opening holes to the outside, so the reed never started.
  const wall = (y) => ({ type: 'wall', points: [{ x: 1, y }, { x: 2.2, y }], thickness: 0.04, material: 'mirror' });
  const pipe = addObject(addObject(createRoom({ ear: { x: 5, y: 2, angle: 0 } }), wall(1.42)), wall(1.58));
  for (const rate of [8000, 11025, 16000, 22050]) {
    for (const material of ['reed', 'foam', 'heavy-gas']) {
      const filled = addObject(pipe, { type: 'rect', x: 1.2, y: 1.5, w: 0.2, h: 0.16, material });
      const mirror = materialId('mirror');
      assert.equal(countOf(rasterise(filled, rate).grid, mirror), countOf(rasterise(pipe, rate).grid, mirror), `${material} at ${rate} Hz`);
      assert.ok(countOf(rasterise(filled, rate).grid, materialId(material)) > 0, `${material} at ${rate} Hz is still painted`);
    }
  }
});

test('a fluid placed against a window never eats into the glass', () => {
  const pane = { type: 'window', a: { x: 2, y: 1 }, b: { x: 2, y: 3 }, thickness: 0.02, open: false };
  const room = addObject(createRoom({ ear: { x: 5, y: 2, angle: 0 } }), pane);
  for (const rate of [8000, 11025, 16000, 22050]) {
    const foamed = addObject(room, { type: 'rect', x: 1.85, y: 2, w: 0.3, h: 1, material: 'foam' });
    assert.equal(countOf(rasterise(foamed, rate).grid, GLASS), countOf(rasterise(room, rate).grid, GLASS), `foam at ${rate} Hz`);
  }
});

test('a thin diagonal window has no gap a wave could slip through', () => {
  const room = addObject(createRoom({ ear: { x: 11, y: 6, angle: 0 } }), {
    type: 'window', a: { x: 2, y: 2 }, b: { x: 5, y: 4.3 },
  });
  const { grid, nx } = rasterise(room, RATE);
  assert.ok(countOf(grid, GLASS) > 0);
  // Every glass cell along the line must touch another through a shared edge, not a corner.
  const cells = [];
  grid.forEach((v, i) => { if (v === GLASS) cells.push(i); });
  const set = new Set(cells);
  for (const i of cells) {
    assert.ok(set.has(i + 1) || set.has(i - 1) || set.has(i + nx) || set.has(i - nx));
  }
});

test('a door physically changes the grid when it opens', () => {
  const door = {
    type: 'door', hinge: { x: 4, y: 3 }, length: 1, angle: Math.PI / 2, open: false, thickness: 0.06, material: 'wood',
  };
  const wall = { type: 'wall', points: [{ x: 4, y: 0 }, { x: 4, y: 7 }], thickness: 0.2, material: 'stone' };
  const base = addObject(createRoom(), wall);
  const closed = addObject(base, door);
  const opened = updateObject(closed, closed.objects[1].id, { open: true });
  const a = rasterise(closed, RATE).grid;
  const b = rasterise(opened, RATE).grid;
  let differ = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differ += 1;
  assert.ok(differ > 50, `only ${differ} cells changed`);
  const leaf = doorLeaf(opened.objects[1]);
  assert.ok(Math.abs(Math.hypot(leaf.b.x - leaf.a.x, leaf.b.y - leaf.a.y) - 1) < 1e-9);
});

test('the listener head is in the grid, and the ears are outside it', () => {
  const room = createRoom({ ear: { x: 6, y: 3, angle: 0.7 } });
  const r = rasterise(room, RATE);
  assert.ok(countOf(r.grid, HEAD) > 5);
  const { left, right } = earPositions(room.ear);
  for (const ear of [left, right]) {
    const c = toCell(ear, r);
    assert.notEqual(r.grid[Math.round(c.y) * r.nx + Math.round(c.x)], HEAD);
  }
});

test('incremental recompile gives exactly the same result as a full compile', () => {
  const start = createRoom({ ear: { x: 9, y: 5, angle: 0 } });
  const a = rasterise(start, RATE);
  const opts = compileOptionsFor(start, RATE, a.margin);
  const compiled = compileGrid(a.grid, a.nx, a.ny, opts);
  const edited = addObject(start, {
    type: 'wall', points: [{ x: 2, y: 2 }, { x: 5, y: 3 }], thickness: 0.15, material: 'wood',
  });
  const b = rasterise(edited, RATE);
  const rect = updateGrid(compiled, b.grid);
  assert.ok(rect);
  const full = compileGrid(b.grid, b.nx, b.ny, opts);
  assert.deepEqual(compiled.flags, full.flags);
  assert.deepEqual(compiled.coef, full.coef);
  assert.equal(updateGrid(compiled, b.grid), null);
});

test('a long stroke paints exactly what painting it whole would', () => {
  const points = Array.from({ length: 200 }, (_, i) => ({ x: 1 + i * 0.05, y: 3 + Math.sin(i * 0.2) }));
  const wall = { type: 'wall', points, thickness: 0.2, material: 'stone' };
  const curve = {
    type: 'curve', a: { x: 1, y: 1 }, control: { x: 6, y: 6 }, b: { x: 11, y: 1 }, thickness: 0.2, material: 'wood',
  };
  const quiet = { ear: { x: 11.5, y: 6.5, angle: 0 } };
  const room = addObject(addObject(createRoom(quiet), wall), curve);
  const { grid, nx, dx } = rasterise(room, RATE);
  const reach = dx * 0.72;
  let checked = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const y = Math.floor(i / nx);
    const x = i - y * nx;
    if (x > 0 && y > 0 && x < nx - 1 && y < grid.length / nx - 1) {
      const p = { x: (x - 0.5) * dx, y: (y - 0.5) * dx };
      const inCurve = signedDistance(room.objects[1], p) <= reach;
      const inWall = signedDistance(room.objects[0], p) <= reach;
      const expected = inCurve ? materialId('wood') : (inWall ? materialId('stone') : grid[i]);
      assert.equal(grid[i], expected, `cell ${x},${y}`);
      checked += inCurve || inWall ? 1 : 0;
    }
  }
  assert.ok(checked > 100);
});

test('open rooms get a sponge margin, closed rooms do not', () => {
  const open = rasterise(createRoom({ edges: 'open' }), RATE);
  const closed = rasterise(createRoom(), RATE);
  assert.ok(open.margin > 0);
  assert.equal(closed.margin, 0);
  assert.ok(open.nx > closed.nx);
});

test('unknown material names are rejected', () => {
  assert.throws(() => materialId('adamantium'), RangeError);
});

test('transforms move shapes correctly', () => {
  const wall = { id: 'w', type: 'wall', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], thickness: 0.2, material: 'stone' };
  const moved = translateObject(wall, 1, 1);
  assert.deepEqual(moved.points[0], { x: 1, y: 1 });
  const rotated = rotateObject(wall, Math.PI / 2, { x: 0, y: 0 });
  assert.ok(Math.abs(rotated.points[1].y - 2) < 1e-9);
  const scaled = scaleObject(wall, 2, { x: 0, y: 0 });
  assert.ok(Math.abs(scaled.points[1].x - 4) < 1e-9);
  const copy = duplicateObject(wall);
  assert.notEqual(copy.id, wall.id);
});

test('what a click selects is what the grid contains', () => {
  const room = addObject(createRoom(), {
    type: 'ellipse', x: 5, y: 3, rx: 2, ry: 1, ring: 0.2, material: 'stone',
  });
  const [ring] = room.objects;
  assert.ok(signedDistance(ring, { x: 7, y: 3 }) <= 0.01);
  assert.ok(signedDistance(ring, { x: 5, y: 3 }) > 0.5);
  assert.equal(objectAt(room, { x: 5, y: 3 }), null);
  assert.equal(objectAt(room, { x: 7, y: 3 }).id, ring.id);
});

test('a curve starts and ends where it says', () => {
  const points = curvePoints({ a: { x: 0, y: 0 }, control: { x: 1, y: 2 }, b: { x: 2, y: 0 } });
  assert.deepEqual(points[0], { x: 0, y: 0 });
  assert.deepEqual(points[points.length - 1], { x: 2, y: 0 });
  assert.equal(AIR, 0);
});
