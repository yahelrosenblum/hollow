// Acoustic challenges. Each one scores what a simulated room actually does, never how it looks.
// Every test bakes the room at one fixed rate, so a result is the same on any machine.
// Each pass condition is written so the obvious shortcut fails: silence can't "cancel" a sound,
// and a target can't count as focused because a source is sitting on it.

import { addObject, createRoom } from '../../scene/room.js';
import { rasterise, toCell } from '../../scene/rasterise.js';
import { isWall } from '../../sim/materials.js';
import { db, decayTime, rms } from '../../audio/analysis.js';
import { arrivalTime, frequencyResponse, throughChain } from '../lab/measure.js';

export const CHALLENGE_RATE = 8000;
export const LEVELS = Object.freeze(['Apprentice', 'Architect', 'Master']);

const AUDIBLE_DB = -45;

const pt = (x, y) => ({ x, y });

function row(label, measured, target, ok) {
  return { label, measured, target, ok };
}

function result(rows, detail = {}) {
  return { pass: rows.every((r) => r.ok), rows, detail };
}

function locked(object) {
  return { ...object, locked: true };
}

function build(fields, objects = []) {
  return objects.reduce((room, object) => addObject(room, locked(object)), createRoom(fields));
}

// Wall length plus foam and gas area, in metres or square metres, for what the player added.
export function materialUsed(room) {
  let total = 0;
  for (const o of room.objects) {
    if (o.locked) continue;
    if (o.type === 'wall') {
      for (let i = 0; i + 1 < o.points.length; i += 1) {
        total += Math.hypot(o.points[i + 1].x - o.points[i].x, o.points[i + 1].y - o.points[i].y);
      }
    } else if (o.type === 'curve') {
      total += Math.hypot(o.a.x - o.control.x, o.a.y - o.control.y) + Math.hypot(o.b.x - o.control.x, o.b.y - o.control.y);
    } else if (o.type === 'rect') {
      total += o.ring ? 2 * (o.w + o.h) : o.w * o.h;
    } else if (o.type === 'ellipse') {
      total += o.ring ? Math.PI * (o.rx + o.ry) : Math.PI * o.rx * o.ry;
    }
  }
  return total;
}

function budgetRow(room, budget) {
  const used = materialUsed(room);
  return row('Material used', `${used.toFixed(1)}`, `at most ${budget}`, used <= budget);
}

// True if solid material lies on the straight line between two points.
export function lineBlocked(room, a, b) {
  const raster = rasterise(room, CHALLENGE_RATE);
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (raster.dx / 2));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const cell = toCell({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, raster);
    if (isWall(raster.grid[Math.round(cell.y) * raster.nx + Math.round(cell.x)])) return true;
  }
  return false;
}

function isOpenAt(room, p) {
  const raster = rasterise(room, CHALLENGE_RATE);
  const cell = toCell(p, raster);
  return !isWall(raster.grid[Math.round(cell.y) * raster.nx + Math.round(cell.x)]);
}

// --- 1. Resonance ---

function resonance(level) {
  const target = [150, 150, 150][level];
  const tolerance = [0.05, 0.02, 0.01][level];
  const source = pt(0.2, 0.25);
  const mic = pt(1, 0.4);
  return {
    key: `resonance-${level}`,
    family: 'resonance',
    level,
    title: `A room that rings at ${target} Hz`,
    objective: `Make the strongest resonance between ${Math.round(target * 0.7)} and ${Math.round(target * 1.3)} Hz land within ${(tolerance * 100).toFixed(0)}% of ${target} Hz, standing clear of everything around it.`,
    phenomenon: `A room resonates when a whole number of half-wavelengths fits between its walls: frequency = speed of sound / (2 × length). For ${target} Hz that is ${(343 / (2 * target)).toFixed(2)} m. Rooms with no parallel walls have weak, muddled modes, which is why studios avoid square rooms.`,
    budget: level === 2 ? 12 : null,
    markers: [{ point: source, label: 'Source' }, { point: mic, label: 'Mic' }],
    start: () => build({
      name: `Resonance, ${LEVELS[level]}`,
      width: 5,
      height: 3.2,
      airLoss: 2.5,
      ear: { x: 4.6, y: 2.8, angle: 0 },
    }),
    reference(room) {
      // A box the right length, and short enough the other way that its other mode sits well
      // above this band. Walls take up grid cells beyond their centre line, hence the offset.
      const wall = (points) => ({ type: 'wall', points, thickness: 0.2, material: 'stone' });
      const x = 343 / (2 * target) + 0.14;
      return [
        wall([pt(x, 0), pt(x, 0.9)]),
        wall([pt(0, 0.9), pt(x, 0.9)]),
      ].reduce(addObject, room);
    },
    async test(room, simulate) {
      const { traces } = await simulate({
        room,
        sources: [{ point: source, stimulus: { kind: 'impulse' } }],
        listeners: [mic],
        seconds: 2,
        rate: CHALLENGE_RATE,
      });
      const processed = throughChain(traces[0], CHALLENGE_RATE);
      const response = frequencyResponse(processed, CHALLENGE_RATE);
      const { db: values, binHz } = response;
      const low = target * 0.7;
      const high = target * 1.3;
      let best = -1;
      let sum = 0;
      let count = 0;
      for (let k = Math.ceil(low / binHz); k <= Math.floor(high / binHz); k += 1) {
        if (best < 0 || values[k] > values[best]) best = k;
        sum += values[k];
        count += 1;
      }
      const hz = best * binHz;
      const rise = values[best] - sum / count;
      const off = Math.abs(hz - target) / target;
      const rows = [
        row('Strongest resonance in the band', `${hz.toFixed(1)} Hz`, `${target} Hz ± ${(tolerance * 100).toFixed(0)}%`, off <= tolerance),
        row('Above the average of that band', `${rise.toFixed(1)} dB`, 'at least 8 dB', rise >= 8),
      ];
      if (this.budget) rows.push(budgetRow(room, this.budget));
      return result(rows, { hz, rise });
    },
  };
}

// --- 2. Cancellation ---

function cancellation(level) {
  const frequency = 500;
  const required = [15, 25, 20][level];
  const point = pt(4, 2.5);
  const phaseAllowed = level < 2;
  return {
    key: `cancellation-${level}`,
    family: 'cancellation',
    level,
    title: level === 2 ? 'Silence by geometry alone' : 'Make two sounds cancel',
    objective: `Two speakers play ${frequency} Hz. At the marked point, get the combined sound at least ${required} dB below the louder speaker alone${phaseAllowed ? '.' : ', without touching their phase: move them instead.'} Each must still be audible there on its own.`,
    phenomenon: 'Waves add by signed pressure, so two equal waves half a cycle apart sum to nothing. Half a cycle can come from the source or from half a wavelength of extra path. The energy has not vanished: it has gone somewhere else in the room. Cancellation at one point always means reinforcement at others.',
    budget: null,
    usesSpeakers: true,
    markers: [{ point, label: 'Target' }],
    phaseLocked: !phaseAllowed,
    start() {
      const room = build({
        name: `Cancellation, ${LEVELS[level]}`,
        width: 8,
        height: 5,
        edges: 'open',
        airLoss: 1,
        // On the centre line: anywhere else, your own head breaks the symmetry being tested.
        ear: { x: 4, y: 4.6, angle: 0 },
      });
      const speaker = (id, name, x, y) => ({
        id, name, x, y, signal: 'tone', frequency, phase: 0, delay: 0, gain: 0.25, on: true,
      });
      return { ...room, speakers: [speaker('a', 'Speaker A', 1.8, 2.5), speaker('b', 'Speaker B', 6.2, 2.5)] };
    },
    reference(room) {
      if (phaseAllowed) {
        return { ...room, speakers: room.speakers.map((s) => (s.id === 'b' ? { ...s, phase: Math.PI } : s)) };
      }
      // An extra half-wavelength of path, far enough away that the levels stay nearly equal.
      const halfWave = 343 / frequency / 2;
      return { ...room, speakers: room.speakers.map((s) => (s.id === 'b' ? { ...s, x: 6.2 + halfWave } : s)) };
    },
    async test(room, simulate) {
      const speakers = room.speakers ?? [];
      if (speakers.length !== 2) {
        return result([row('Speakers', `${speakers.length}`, 'exactly 2', false)]);
      }
      if (!phaseAllowed && speakers.some((s) => s.phase !== 0)) {
        return result([row('Phase', 'changed', 'left at 0', false)]);
      }
      const tone = (s) => ({
        point: s, stimulus: { kind: 'tone', frequency: s.frequency, amplitude: s.gain, phase: s.phase },
      });
      const level2 = async (list) => {
        const { traces } = await simulate({
          room, sources: list, listeners: [point], seconds: 0.5, rate: CHALLENGE_RATE,
        });
        const trace = traces[0];
        return rms(trace, Math.floor(trace.length / 2));
      };
      const [a, b] = speakers;
      const aOnly = await level2([tone(a)]);
      const bOnly = await level2([tone(b)]);
      const both = await level2([tone(a), tone(b)]);
      const louder = Math.max(aOnly, bOnly);
      const depth = db(both / (louder || 1e-30));
      const quieter = db(Math.min(aOnly, bOnly));
      return result([
        row('Combined, against the louder speaker alone', `${depth.toFixed(1)} dB`, `at most -${required} dB`, depth <= -required),
        row('The quieter speaker, on its own', `${quieter.toFixed(1)} dB`, `above ${AUDIBLE_DB} dB`, quieter > AUDIBLE_DB),
      ], { depth, aOnly, bOnly, both });
    },
  };
}

// --- 3. Whispering gallery ---

function whisperingGallery(level) {
  const required = [5, 8, 10][level];
  const source = pt(2, 3);
  const target = pt(8, 3);
  const radius = 6;
  const comparisons = [-2.2, -1.5, -0.8, 0.8, 1.5, 2.2].map((a) => pt(source.x + Math.cos(a) * radius * 0.5, source.y + Math.sin(a) * radius * 0.5));
  return {
    key: `gallery-${level}`,
    family: 'gallery',
    level,
    title: 'Build a whispering gallery',
    objective: `A screen blocks the direct line. Shape the room so a whisper at the source arrives at the target at least ${required} dB louder than at other points in the room.`,
    phenomenon: 'An ellipse has two foci, and every ray leaving one reflects off the curve to the other, all with the same path length, so they arrive together. St Paul\'s Cathedral and the US Capitol have rooms where a whisper crosses tens of metres this way.',
    budget: level === 2 ? 30 : null,
    markers: [{ point: source, label: 'Whisper' }, { point: target, label: 'Listener' }],
    start: () => build({
      name: `Whispering gallery, ${LEVELS[level]}`,
      width: 10,
      height: 6,
      edges: 'open',
      airLoss: 1,
      ear: { x: 9.4, y: 5.4, angle: 0 },
    }, [{
      type: 'wall', points: [pt(5, 2), pt(5, 4)], thickness: 0.2, material: 'stone',
    }]),
    reference(room) {
      const focus = 3;
      const rx = 4.4;
      const ry = Math.sqrt(rx * rx - focus * focus);
      return addObject(room, {
        type: 'ellipse', x: 5, y: 3, rx: rx + 0.15, ry: ry + 0.15, ring: 0.3, material: 'stone',
      });
    },
    async test(room, simulate) {
      const blocked = lineBlocked(room, source, target);
      const { traces } = await simulate({
        room,
        sources: [{ point: source, stimulus: { kind: 'clap' } }],
        listeners: [target, ...comparisons],
        seconds: 0.35,
        rate: CHALLENGE_RATE,
      });
      const levelAt = (trace) => rms(trace);
      const atTarget = levelAt(traces[0]);
      const others = traces.slice(1).map(levelAt);
      const reference = Math.sqrt(others.reduce((s, v) => s + v * v, 0) / others.length);
      const gain = db(atTarget / (reference || 1e-30));
      const rows = [
        row('Direct line', blocked ? 'blocked' : 'open', 'blocked', blocked),
        row('Target, against the rest of the room', `${gain.toFixed(1)} dB`, `at least ${required} dB`, gain >= required),
      ];
      if (this.budget) rows.push(budgetRow(room, this.budget));
      return result(rows, { gain, blocked });
    },
  };
}

// --- 4. Decay time ---

function decay(level) {
  const target = 0.6;
  const tolerance = [0.2, 0.1, 0.05][level];
  const source = pt(1.2, 1);
  const mic = pt(4.6, 2.9);
  return {
    key: `decay-${level}`,
    family: 'decay',
    level,
    title: `An echo that fades in ${target} s`,
    objective: `This stone room rings too long. Treat it so its measured decay time (RT60) is within ${(tolerance * 100).toFixed(0)}% of ${target} s.`,
    phenomenon: 'Each reflection removes a fraction of the sound, so decay time depends on how often sound hits a surface and how much that surface absorbs. Wallace Sabine worked this out around 1900 by timing organ notes in a lecture hall, with cushions borrowed from a theatre. Where absorption goes matters too: foam on one wall can make things worse, because sound keeps bouncing between the two walls you left bare.',
    budget: level === 2 ? 1.6 : null,
    markers: [{ point: source, label: 'Source' }, { point: mic, label: 'Mic' }],
    start: () => build({
      name: `Decay time, ${LEVELS[level]}`,
      width: 6,
      height: 4,
      airLoss: 0.5,
      ear: { x: 5.5, y: 3.5, angle: 0 },
    }),
    reference(room) {
      // Two adjacent walls, so no pair of parallel surfaces is left to bounce between.
      return [
        { x: 3, y: 0.15, w: 2, h: 0.3 },
        { x: 0.15, y: 2, w: 0.3, h: 3 },
      ].reduce((r, shape) => addObject(r, { type: 'rect', material: 'foam', ...shape }), room);
    },
    async test(room, simulate) {
      const { traces } = await simulate({
        room,
        sources: [{ point: source, stimulus: { kind: 'impulse' } }],
        listeners: [mic],
        seconds: 3.5,
        rate: CHALLENGE_RATE,
      });
      const measured = decayTime(throughChain(traces[0], CHALLENGE_RATE), CHALLENGE_RATE);
      const ok = measured !== null && Math.abs(measured - target) / target <= tolerance;
      const rows = [row(
        'Measured decay time',
        measured === null ? 'longer than this test can measure' : `${measured.toFixed(2)} s`,
        `${target} s ± ${(tolerance * 100).toFixed(0)}%`,
        ok,
      )];
      if (this.budget) rows.push(budgetRow(room, this.budget));
      return result(rows, { measured });
    },
  };
}

// --- 5. Focus ---

function focus(level) {
  const required = [3, 5, 8][level];
  const source = pt(2, 3);
  const target = pt(7.5, 3);
  const samples = [];
  for (let x = 1; x < 10; x += 1.5) {
    for (let y = 0.8; y < 6; y += 1.1) {
      if (Math.hypot(x - source.x, y - source.y) > 1.2 && Math.hypot(x - target.x, y - target.y) > 1) samples.push(pt(x, y));
    }
  }
  return {
    key: `focus-${level}`,
    family: 'focus',
    level,
    title: 'Gather sound at one point',
    objective: `Put at least ${required} times the room's average energy on the marked point. Reflect it, or bend it with heavy gas.`,
    phenomenon: 'A curved reflector or a lens gives every path from source to target the same length, so the waves arrive in step and add up. Sound mirrors were built along the English coast in the 1920s to hear aircraft coming, before radar replaced them.',
    budget: level === 2 ? 25 : null,
    markers: [{ point: source, label: 'Source' }, { point: target, label: 'Focus here' }],
    start: () => build({
      name: `Focus, ${LEVELS[level]}`,
      width: 10,
      height: 6,
      edges: 'open',
      airLoss: 1,
      ear: { x: 9.4, y: 5.4, angle: 0 },
    }),
    reference(room) {
      const c = (source.x + target.x) / 2;
      const half = (target.x - source.x) / 2;
      const rx = half + 0.9;
      const ry = Math.sqrt(rx * rx - half * half);
      return addObject(room, {
        type: 'ellipse', x: c, y: 3, rx: rx + 0.15, ry: ry + 0.15, ring: 0.3, material: 'stone',
      });
    },
    async test(room, simulate) {
      const open = samples.filter((p) => isOpenAt(room, p));
      const { traces } = await simulate({
        room,
        sources: [{ point: source, stimulus: { kind: 'clap' } }],
        listeners: [target, ...open],
        seconds: 0.4,
        rate: CHALLENGE_RATE,
      });
      const energy = (trace) => trace.reduce((sum, v) => sum + v * v, 0);
      const atTarget = energy(traces[0]);
      const average = traces.slice(1).reduce((sum, t) => sum + energy(t), 0) / Math.max(1, traces.length - 1);
      const ratio = average > 0 ? atTarget / average : 0;
      const away = Math.hypot(target.x - source.x, target.y - source.y);
      const rows = [
        row('Energy at the point, against the room average', `${ratio.toFixed(1)} ×`, `at least ${required} ×`, ratio >= required),
        row('Source distance from the point', `${away.toFixed(1)} m`, 'at least 2 m', away >= 2),
      ];
      if (this.budget) rows.push(budgetRow(room, this.budget));
      return result(rows, { ratio });
    },
  };
}

// --- 6. Two listeners ---

function twoListeners(level) {
  const targetMs = 5;
  const tolerance = [2, 1, 0.5][level];
  const source = pt(1.5, 2.5);
  const near = pt(5, 1.2);
  const far = pt(5, 3.8);
  return {
    key: `listeners-${level}`,
    family: 'listeners',
    level,
    title: 'Sound that arrives twice',
    objective: `Two listeners stand the same distance from the source. Make the sound reach one of them ${targetMs} ms after the other, within ${tolerance} ms. Both must still hear it clearly.`,
    phenomenon: `Sound travels 34 cm in a millisecond, so ${targetMs} ms is ${(targetMs * 0.343).toFixed(1)} m of extra path. A wall in the way forces the first sound around its end: that bending is diffraction, and it is why you can hear someone around a corner without seeing them.`,
    budget: level === 2 ? 8 : null,
    markers: [{ point: source, label: 'Source' }, { point: near, label: 'Listener 1' }, { point: far, label: 'Listener 2' }],
    start: () => build({
      name: `Two listeners, ${LEVELS[level]}`,
      width: 7,
      height: 5,
      edges: 'open',
      airLoss: 1,
      ear: { x: 6.5, y: 4.5, angle: 0 },
    }),
    reference(room) {
      // Screens that force the sound through an S-bend to reach one listener only.
      return [
        [pt(3, 2.5), pt(3, 4.2)],
        [pt(3, 2.5), pt(7, 2.5)],
        [pt(4.1, 5), pt(4.1, 3)],
      ].reduce((r, points) => addObject(r, { type: 'wall', points, thickness: 0.2, material: 'stone' }), room);
    },
    async test(room, simulate) {
      const { traces } = await simulate({
        room,
        sources: [{ point: source, stimulus: { kind: 'impulse' } }],
        listeners: [near, far],
        seconds: 0.08,
        rate: CHALLENGE_RATE,
      });
      const processed = traces.map((t) => throughChain(t, CHALLENGE_RATE));
      const arrive = processed.map((t) => arrivalTime(t, CHALLENGE_RATE, -14));
      const peak = processed.map((t) => t.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
      const separation = arrive[0] === null || arrive[1] === null ? null : Math.abs(arrive[0] - arrive[1]) * 1000;
      const weaker = db(Math.min(...peak) / (Math.max(...peak) || 1e-30));
      const rows = [
        row(
          'Difference in arrival',
          separation === null ? 'no sound' : `${separation.toFixed(1)} ms`,
          `${targetMs} ms ± ${tolerance} ms`,
          separation !== null && Math.abs(separation - targetMs) <= tolerance,
        ),
        row('The quieter listener, against the louder', `${weaker.toFixed(1)} dB`, 'above -30 dB', weaker > -30),
      ];
      if (this.budget) rows.push(budgetRow(room, this.budget));
      return result(rows, { separation, weaker });
    },
  };
}

const FAMILIES = [resonance, cancellation, whisperingGallery, decay, focus, twoListeners];

export const CHALLENGES = Object.freeze(
  FAMILIES.flatMap((make) => LEVELS.map((_, level) => make(level))),
);

export function challengeByKey(key) {
  return CHALLENGES.find((c) => c.key === key) ?? null;
}
