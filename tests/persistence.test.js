import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRoom } from '../src/scene/schema.js';
import { decodeRoom, encodeRoom, roomFromHash, roomLink } from '../src/scene/sharelink.js';
import { Autosave } from '../src/scene/autosave.js';
import { SCENES, makeScene } from '../src/scene/presets.js';
import { createRoom } from '../src/scene/room.js';
import { constrainAngle, simplifyStroke, snapPoint } from '../src/features/build/snap.js';
import { History } from '../src/app/history.js';

class MemoryStorage {
  constructor() {
    this.stores = { journal: [], meta: new Map() };
    this.seq = 0;
  }

  async put(store, value) {
    if (store === 'journal') {
      this.seq += 1;
      this.stores.journal.push({ seq: this.seq, ...value });
    } else {
      this.stores[store].set(value.key, value);
    }
  }

  async get(store, key) {
    return this.stores[store].get(key);
  }

  async newest(store, limit) {
    return [...this.stores[store]].reverse().slice(0, limit);
  }

  async oldestKeysBeyond(store, keep) {
    return this.stores[store].slice(0, Math.max(0, this.stores[store].length - keep)).map((e) => e.seq);
  }

  async delete(store, key) {
    this.stores[store] = this.stores[store].filter((e) => e.seq !== key);
  }
}

test('every built-in scene passes validation', () => {
  for (const scene of SCENES) {
    const result = validateRoom(makeScene(scene.key));
    assert.ok(result.ok, `${scene.key}: ${result.error}`);
  }
});

test('validation rejects malformed rooms with a reason', () => {
  const bad = [
    null,
    { schema: 1 },
    { ...createRoom(), schema: 99 },
    { ...createRoom(), width: 1e9 },
    { ...createRoom(), width: 'wide' },
    { ...createRoom(), objects: 'nope' },
    { ...createRoom(), objects: [{ type: 'portal' }] },
    { ...createRoom(), objects: [{ type: 'wall', points: [{ x: 0, y: 0 }], thickness: 0.1, material: 'stone' }] },
    { ...createRoom(), objects: [{ type: 'rect', x: 1, y: 1, w: 1, h: 1, material: 'adamantium' }] },
    { ...createRoom(), objects: [{ type: 'rect', x: NaN, y: 1, w: 1, h: 1, material: 'stone' }] },
    { ...createRoom(), objects: new Array(5000).fill({ type: 'rect', x: 1, y: 1, w: 1, h: 1, material: 'stone' }) },
    { ...createRoom(), speakers: new Array(50).fill({ x: 1, y: 1 }) },
    { ...createRoom(), edgeMaterial: 'air' },
  ];
  for (const room of bad) {
    const result = validateRoom(room);
    assert.equal(result.ok, false, JSON.stringify(room)?.slice(0, 80));
    assert.equal(typeof result.error, 'string');
  }
});

test('a small file cannot ask for an enormous amount of painting', () => {
  // Regression: a few KB of full-room shapes hung the worker, on every launch once autosaved.
  const room = createRoom({ width: 40, height: 40 });
  const heavy = {
    ...room,
    objects: Array.from({ length: 2000 }, (_, i) => ({
      id: `o${i}`, type: 'rect', x: 20, y: 20, w: 40, h: 40, material: 'stone',
    })),
  };
  const result = validateRoom(heavy);
  assert.equal(result.ok, false);
  assert.match(result.error, /too complicated/);
});

test('every built-in scene is well inside the painting limit', () => {
  for (const scene of SCENES) assert.ok(validateRoom(scene.make()).ok, scene.key);
});

test('speakers and suggested sources are kept inside the room', () => {
  const result = validateRoom({
    ...createRoom({ width: 5, height: 4 }),
    suggestedSource: { x: 1e6, y: -1e6 },
    speakers: [{ id: 's', x: 900, y: -900, frequency: 440 }],
  });
  assert.ok(result.ok);
  assert.deepEqual([result.room.speakers[0].x, result.room.speakers[0].y], [5, 0]);
  assert.deepEqual(result.room.suggestedSource, { x: 5, y: 0 });
});

test('validation drops unknown fields, so a file cannot smuggle anything in', () => {
  const result = validateRoom({
    ...createRoom(),
    evil: '<script>',
    objects: [{
      id: 'a', type: 'rect', x: 1, y: 1, w: 1, h: 1, material: 'stone', onclick: 'steal()',
    }],
  });
  assert.ok(result.ok);
  assert.equal(result.room.evil, undefined);
  assert.equal(result.room.objects[0].onclick, undefined);
});

test('the listener cannot be placed outside the room', () => {
  const result = validateRoom({ ...createRoom(), ear: { x: 500, y: -5, angle: 0 } });
  assert.ok(result.ok);
  assert.ok(result.room.ear.x <= result.room.width);
  assert.ok(result.room.ear.y >= 0);
});

test('a room survives a trip through a share link', async () => {
  const room = makeScene('cathedral');
  const decoded = await decodeRoom(await encodeRoom(room));
  assert.ok(decoded.ok, decoded.error);
  assert.equal(decoded.room.name, room.name);
  assert.equal(decoded.room.objects.length, room.objects.length);
  assert.ok(Math.abs(decoded.room.objects[0].x - room.objects[0].x) < 0.001);
});

test('a share link keeps the room in the fragment', async () => {
  const { link } = await roomLink(makeScene('next-door'), 'https://example.test/');
  assert.ok(link.startsWith('https://example.test/#room='));
  assert.ok(roomFromHash(new URL(link).hash));
  assert.equal(roomFromHash('#other'), null);
});

test('garbage in a link is refused, not thrown', async () => {
  for (const junk of ['!!!!', 'AAAA', '']) {
    const result = await decodeRoom(junk);
    assert.equal(result.ok, false);
  }
});

test('a share link cannot bypass validation', async () => {
  const encoded = await encodeRoom({ ...createRoom(), width: 1e9 });
  assert.equal((await decodeRoom(encoded)).ok, false);
});

function memoryMarker() {
  const map = new Map();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v),
    remove: (k) => map.delete(k),
  };
}

test('autosave journals edits and recovers the newest room', async () => {
  const storage = new MemoryStorage();
  const marker = memoryMarker();
  const autosave = new Autosave(storage, { delay: 1, marker });
  autosave.begin();
  autosave.note(createRoom({ name: 'First' }));
  await autosave.flush();
  autosave.note(createRoom({ name: 'Second' }));
  await autosave.flush();
  // No clean exit: the next launch sees a crash.
  const recovered = await new Autosave(storage, { marker }).recover();
  assert.equal(recovered.crashed, true);
  assert.equal(recovered.room.name, 'Second');
});

test('a clean exit is not reported as a crash', async () => {
  const storage = new MemoryStorage();
  const marker = memoryMarker();
  const autosave = new Autosave(storage, { delay: 1, marker });
  autosave.begin();
  autosave.note(createRoom({ name: 'Only' }));
  await autosave.endCleanly();
  const recovered = await new Autosave(storage, { marker }).recover();
  assert.equal(recovered.crashed, false);
  assert.equal(recovered.room.name, 'Only');
});

test('the clean-exit marker is written before endCleanly returns', () => {
  // Regression: it used to wait for an async save, and a closing page never got that far, so
  // every ordinary reload was reported as a crash.
  const marker = memoryMarker();
  const autosave = new Autosave(new MemoryStorage(), { marker });
  autosave.begin();
  assert.equal(marker.get('hollow.session'), 'open');
  autosave.endCleanly();
  assert.equal(marker.get('hollow.session'), 'closed');
});

test('an edit still waiting to save survives closing the page', async () => {
  // The journal write never lands here, as can happen while a page unloads.
  const storage = new MemoryStorage();
  storage.put = () => new Promise(() => {});
  const marker = memoryMarker();
  const autosave = new Autosave(storage, { delay: 100000, marker });
  autosave.begin();
  autosave.note(createRoom({ name: 'Just edited' }));
  autosave.endCleanly();
  const recovered = await new Autosave(new MemoryStorage(), { marker }).recover();
  assert.equal(recovered.room.name, 'Just edited');
  assert.equal(recovered.crashed, false);
  assert.equal(marker.get('hollow.pending'), null);
});

test('a damaged pending edit is skipped, not fatal', async () => {
  const storage = new MemoryStorage();
  const marker = memoryMarker();
  const first = new Autosave(storage, { delay: 1, marker });
  first.note(createRoom({ name: 'Saved' }));
  await first.flush();
  marker.set('hollow.pending', '{not json');
  const recovered = await new Autosave(storage, { marker }).recover();
  assert.equal(recovered.room.name, 'Saved');
  assert.equal(recovered.skipped, 1);
});

test('a corrupt journal entry falls back to the previous version', async () => {
  const storage = new MemoryStorage();
  const marker = memoryMarker();
  const autosave = new Autosave(storage, { delay: 1, marker });
  autosave.note(createRoom({ name: 'Good' }));
  await autosave.flush();
  await storage.put('journal', { room: { schema: 1, width: 'corrupt' }, savedAt: Date.now() });
  const recovered = await new Autosave(storage, { marker }).recover();
  assert.equal(recovered.room.name, 'Good');
  assert.equal(recovered.skipped, 1);
});

test('autosave keeps a bounded number of versions', async () => {
  const storage = new MemoryStorage();
  const marker = memoryMarker();
  const autosave = new Autosave(storage, { delay: 1, marker });
  for (let i = 0; i < 80; i += 1) {
    autosave.note(createRoom({ name: `v${i}` }));
    await autosave.flush();
  }
  assert.ok(storage.stores.journal.length <= 60);
  assert.equal((await new Autosave(storage, { marker }).recover()).room.name, 'v79');
});

test('snap prefers a wall end over the grid, so walls actually meet', () => {
  const room = {
    objects: [{ id: 'w', type: 'wall', points: [{ x: 1.03, y: 1.07 }, { x: 3, y: 1 }], thickness: 0.2, material: 'stone' }],
  };
  const snapped = snapPoint(room, { x: 1.1, y: 1.1 });
  assert.equal(snapped.snapped, 'end');
  assert.equal(snapped.x, 1.03);
  const grid = snapPoint(room, { x: 5.1, y: 5.1 }, { grid: 0.25 });
  assert.equal(grid.snapped, 'grid');
  assert.equal(grid.x, 5);
});

test('snap can be turned off', () => {
  const free = snapPoint({ objects: [] }, { x: 1.234, y: 5.678 }, { snapGrid: false, snapEnds: false });
  assert.equal(free.x, 1.234);
});

test('angle constraint lands on 15 degree steps and keeps length', () => {
  const end = constrainAngle({ x: 0, y: 0 }, { x: 1, y: 0.02 });
  assert.ok(Math.abs(end.y) < 1e-9);
  assert.ok(Math.abs(Math.hypot(end.x, end.y) - Math.hypot(1, 0.02)) < 1e-9);
});

test('freehand strokes are simplified but keep both ends', () => {
  const points = Array.from({ length: 200 }, (_, i) => ({ x: i * 0.001, y: 0 }));
  const out = simplifyStroke(points);
  assert.ok(out.length < 20);
  assert.deepEqual(out[0], points[0]);
  assert.deepEqual(out[out.length - 1], points[199]);
});

test('undo and redo walk through history, and a drag is one undo', () => {
  const history = new History('a');
  history.push('b');
  history.push('c', 'drag');
  history.push('d', 'drag');
  history.push('e', 'drag');
  assert.equal(history.undo(), 'b');
  assert.equal(history.undo(), 'a');
  assert.equal(history.canUndo, false);
  assert.equal(history.redo(), 'b');
  assert.equal(history.redo(), 'e');
  assert.equal(history.canRedo, false);
  history.undo();
  history.push('new');
  assert.equal(history.canRedo, false);
});
