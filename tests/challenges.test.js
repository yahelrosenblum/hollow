// Every challenge is proven solvable by a reference solution, proven not already solved by its
// starting room, and tested against the obvious ways of cheating. All of it through the solver.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHALLENGES, CHALLENGE_RATE, LEVELS, challengeByKey, lineBlocked, materialUsed,
} from '../src/features/challenges/definitions.js';
import { bakeCpu } from '../src/sim/bake-cpu.js';
import { removeObjects, addObject } from '../src/scene/room.js';
import { validateRoom } from '../src/scene/schema.js';

const simulate = async (args) => bakeCpu(args);

function summary(outcome) {
  return outcome.rows.map((r) => `${r.ok ? 'ok' : 'NO'} ${r.label}: ${r.measured} (want ${r.target})`).join('; ');
}

test('there are six challenges at each of three levels', () => {
  assert.equal(CHALLENGES.length, 18);
  assert.equal(LEVELS.length, 3);
  assert.equal(new Set(CHALLENGES.map((c) => c.key)).size, 18);
});

test('every challenge explains itself', () => {
  for (const c of CHALLENGES) {
    assert.ok(c.title.length > 3, c.key);
    assert.ok(c.objective.length > 20, c.key);
    assert.ok(c.phenomenon.length > 40, c.key);
    assert.ok(c.markers.length >= 1, c.key);
  }
});

test('starting rooms and solutions survive saving and loading', () => {
  for (const c of CHALLENGES) {
    const start = validateRoom(c.start());
    assert.ok(start.ok, `${c.key}: ${start.error}`);
    const solved = validateRoom(c.reference(c.start()));
    assert.ok(solved.ok, `${c.key}: ${solved.error}`);
  }
});

test('a locked object stays locked through a save', () => {
  const start = challengeByKey('gallery-0').start();
  const checked = validateRoom(start);
  assert.equal(checked.room.objects[0].locked, true);
});

for (const family of ['resonance', 'cancellation', 'gallery', 'decay', 'focus', 'listeners']) {
  test(`${family}: the starting room fails and the reference solution passes, at every level`, async () => {
    const levels = CHALLENGES.filter((c) => c.family === family);
    for (const c of levels) {
      const start = await c.test(c.start(), simulate);
      assert.equal(start.pass, false, `${c.key} is already solved: ${summary(start)}`);
      const solved = await c.test(c.reference(c.start()), simulate);
      assert.equal(solved.pass, true, `${c.key} reference failed: ${summary(solved)}`);
    }
  });
}

test('cancellation: silence is not cancellation', async () => {
  const c = challengeByKey('cancellation-0');
  const room = c.start();
  const silent = { ...room, speakers: room.speakers.map((s) => ({ ...s, gain: 0 })) };
  assert.equal((await c.test(silent, simulate)).pass, false);
});

test('cancellation: walling off the target is not cancellation', async () => {
  const c = challengeByKey('cancellation-0');
  const room = addObject(c.start(), {
    type: 'ellipse', x: 4, y: 2.5, rx: 0.6, ry: 0.6, ring: 0.2, material: 'stone',
  });
  assert.equal((await c.test(room, simulate)).pass, false);
});

test('cancellation: removing a speaker is refused', async () => {
  const c = challengeByKey('cancellation-0');
  const room = c.start();
  const outcome = await c.test({ ...room, speakers: room.speakers.slice(0, 1) }, simulate);
  assert.equal(outcome.pass, false);
});

test('cancellation at master level: changing phase is refused', async () => {
  const c = challengeByKey('cancellation-2');
  const room = c.start();
  const flipped = { ...room, speakers: room.speakers.map((s) => (s.id === 'b' ? { ...s, phase: Math.PI } : s)) };
  const outcome = await c.test(flipped, simulate);
  assert.equal(outcome.pass, false);
});

test('gallery: removing the screen does not count', async () => {
  const c = challengeByKey('gallery-0');
  const solved = c.reference(c.start());
  const screen = solved.objects.find((o) => o.locked);
  const opened = removeObjects(solved, [screen.id]);
  const outcome = await c.test(opened, simulate);
  assert.equal(outcome.rows.find((r) => r.label === 'Direct line').ok, false);
  assert.equal(outcome.pass, false);
});

test('gallery: a screen is only blocking if it is really in the way', () => {
  const c = challengeByKey('gallery-0');
  const room = c.start();
  assert.equal(lineBlocked(room, { x: 2, y: 3 }, { x: 8, y: 3 }), true);
  assert.equal(lineBlocked(room, { x: 2, y: 1 }, { x: 8, y: 1 }), false);
});

test('master levels enforce their material budget', async () => {
  const c = challengeByKey('decay-2');
  const wasteful = addObject(c.reference(c.start()), {
    type: 'rect', x: 3, y: 3.7, w: 6, h: 0.6, material: 'foam',
  });
  assert.ok(materialUsed(wasteful) > c.budget);
  const outcome = await c.test(wasteful, simulate);
  assert.equal(outcome.rows.find((r) => r.label === 'Material used').ok, false);
  assert.equal(outcome.pass, false);
});

test('fixed walls do not count against the budget', () => {
  const c = challengeByKey('gallery-2');
  assert.equal(materialUsed(c.start()), 0);
});

test('a decay too long to measure is a failure, not a guess', async () => {
  const c = challengeByKey('decay-0');
  const outcome = await c.test({ ...c.start(), edgeMaterial: 'mirror', airLoss: 0.05 }, simulate);
  assert.equal(outcome.pass, false);
  assert.match(outcome.rows[0].measured, /longer/);
});

test('two listeners: blocking one completely fails', async () => {
  const c = challengeByKey('listeners-0');
  const sealed = addObject(c.start(), {
    type: 'ellipse', x: 5, y: 3.8, rx: 0.7, ry: 0.7, ring: 0.3, material: 'stone',
  });
  assert.equal((await c.test(sealed, simulate)).pass, false);
});

test('challenges bake at one fixed rate, so a score is the same on any machine', () => {
  assert.equal(CHALLENGE_RATE, 8000);
});
