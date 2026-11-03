// The only way a room gets in from outside: files, share links and saved storage all pass
// through here. Anything malformed is rejected with a reason, and unknown fields are dropped,
// so a room file can't smuggle anything into the app. Limits keep a hostile file from
// asking for a grid that would take the machine down.

import { MATERIALS } from '../sim/materials.js';
import {
  OBJECT_TYPES, ROOM_SCHEMA, createRoom, newId, objectBounds, paintPieces,
} from './room.js';

export const LIMITS = Object.freeze({
  minSize: 1,
  maxSize: 40,
  maxObjects: 2000,
  maxPoints: 4000,
  maxSpeakers: 8,
  maxName: 80,
  maxAirLoss: 50,
  maxFrequency: 12000,
  // Area painted, summed over every piece of every object, as a multiple of the room. A small
  // file could otherwise ask for thousands of full-room shapes and hang every launch.
  maxPaintedRooms: 200,
});

function paintedArea(objects) {
  let total = 0;
  for (const object of objects) {
    for (const piece of paintPieces(object)) {
      const b = objectBounds(piece);
      total += Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    }
  }
  return total;
}

function clampPoint(point, width, height) {
  return {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  };
}

const MATERIAL_KEYS = new Set(MATERIALS.filter((m) => m.key !== 'head').map((m) => m.key));
const EDGE_MATERIALS = new Set(MATERIALS.filter((m) => m.kind === 'wall' && m.key !== 'head').map((m) => m.key));

class RoomError extends Error {}

function fail(message) {
  throw new RoomError(message);
}

function number(value, name, min = -1e6, max = 1e6) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a number`);
  if (value < min || value > max) fail(`${name} is out of range`);
  return value;
}

function optionalNumber(value, name, fallback, min, max) {
  return value === undefined ? fallback : number(value, name, min, max);
}

function point(value, name) {
  if (!value || typeof value !== 'object') fail(`${name} must be a point`);
  return { x: number(value.x, `${name}.x`), y: number(value.y, `${name}.y`) };
}

function material(value) {
  if (!MATERIAL_KEYS.has(value)) fail(`unknown material "${String(value).slice(0, 30)}"`);
  return value;
}

function text(value, fallback, max = LIMITS.maxName) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') fail('text fields must be strings');
  return value.slice(0, max);
}

function cleanObject(raw) {
  if (!raw || typeof raw !== 'object') fail('objects must be objects');
  if (!OBJECT_TYPES.includes(raw.type)) fail(`unknown object type "${String(raw.type).slice(0, 30)}"`);
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 40) : newId();
  const base = { id, type: raw.type };
  if (raw.locked === true) base.locked = true;
  switch (raw.type) {
    case 'wall': {
      if (!Array.isArray(raw.points) || raw.points.length < 2) fail('a wall needs at least two points');
      if (raw.points.length > LIMITS.maxPoints) fail('a wall has too many points');
      return {
        ...base,
        points: raw.points.map((p) => point(p, 'wall point')),
        thickness: number(raw.thickness, 'thickness', 0, 5),
        material: material(raw.material),
      };
    }
    case 'curve':
      return {
        ...base,
        a: point(raw.a, 'a'),
        control: point(raw.control, 'control'),
        b: point(raw.b, 'b'),
        thickness: number(raw.thickness, 'thickness', 0, 5),
        material: material(raw.material),
      };
    case 'rect':
    case 'ellipse': {
      const shape = {
        ...base,
        x: number(raw.x, 'x'),
        y: number(raw.y, 'y'),
        rotation: optionalNumber(raw.rotation, 'rotation', 0, -100, 100),
        material: material(raw.material),
      };
      if (raw.ring !== undefined) shape.ring = number(raw.ring, 'ring', 0, 10);
      if (raw.type === 'rect') return { ...shape, w: number(raw.w, 'w', 0, 100), h: number(raw.h, 'h', 0, 100) };
      return { ...shape, rx: number(raw.rx, 'rx', 0, 100), ry: number(raw.ry, 'ry', 0, 100) };
    }
    case 'door':
      return {
        ...base,
        hinge: point(raw.hinge, 'hinge'),
        length: number(raw.length, 'length', 0, 20),
        angle: number(raw.angle, 'angle', -100, 100),
        swing: optionalNumber(raw.swing, 'swing', Math.PI / 2, -7, 7),
        open: Math.max(0, Math.min(1, Number(raw.open) || 0)),
        thickness: optionalNumber(raw.thickness, 'thickness', 0.08, 0, 2),
        frame: optionalNumber(raw.frame, 'frame', 0.3, 0, 3),
        material: material(raw.material ?? 'wood'),
      };
    case 'window':
      return {
        ...base,
        a: point(raw.a, 'a'),
        b: point(raw.b, 'b'),
        open: raw.open === true,
        thickness: optionalNumber(raw.thickness, 'thickness', 0.02, 0, 1),
      };
    case 'opening':
      return { ...base, a: point(raw.a, 'a'), b: point(raw.b, 'b'), width: number(raw.width, 'width', 0, 10) };
    default:
      return fail('unknown object');
  }
}

function cleanSpeaker(raw) {
  if (!raw || typeof raw !== 'object') fail('speakers must be objects');
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 40) : newId('s'),
    name: text(raw.name, 'Speaker', 30),
    x: number(raw.x, 'speaker x'),
    y: number(raw.y, 'speaker y'),
    signal: raw.signal === 'noise' ? 'noise' : 'tone',
    frequency: optionalNumber(raw.frequency, 'frequency', 440, 10, LIMITS.maxFrequency),
    phase: optionalNumber(raw.phase, 'phase', 0, -100, 100),
    delay: optionalNumber(raw.delay, 'delay', 0, 0, 10),
    gain: optionalNumber(raw.gain, 'gain', 0.25, 0, 1),
    on: raw.on === true,
    ...(raw.locked === true ? { locked: true } : {}),
  };
}

export function validateRoom(raw) {
  try {
    if (!raw || typeof raw !== 'object') fail('this is not a Hollow room');
    if (raw.schema !== ROOM_SCHEMA) fail(`this room uses format ${String(raw.schema).slice(0, 10)}, and this version reads format ${ROOM_SCHEMA}`);
    const width = number(raw.width, 'width', LIMITS.minSize, LIMITS.maxSize);
    const height = number(raw.height, 'height', LIMITS.minSize, LIMITS.maxSize);
    if (!Array.isArray(raw.objects)) fail('objects must be a list');
    if (raw.objects.length > LIMITS.maxObjects) fail('this room has too many objects');
    const speakers = Array.isArray(raw.speakers) ? raw.speakers : [];
    if (speakers.length > LIMITS.maxSpeakers) fail('this room has too many speakers');
    const ear = raw.ear ?? {};
    const edgeMaterial = raw.edgeMaterial ?? 'stone';
    if (!EDGE_MATERIALS.has(edgeMaterial)) fail('the room edge must be a wall material');
    const objects = raw.objects.map(cleanObject);
    if (paintedArea(objects) > width * height * LIMITS.maxPaintedRooms) fail('this room is too complicated to simulate');
    const room = createRoom({
      name: text(raw.name, 'Untitled room'),
      width,
      height,
      edges: raw.edges === 'open' ? 'open' : 'closed',
      edgeMaterial,
      airLoss: optionalNumber(raw.airLoss, 'airLoss', 1.5, 0, LIMITS.maxAirLoss),
      lossless: raw.lossless === true,
      objects,
      speakers: speakers.map(cleanSpeaker).map((s) => ({ ...s, ...clampPoint(s, width, height) })),
      ear: {
        x: Math.max(0.2, Math.min(width - 0.2, number(ear.x, 'listener x'))),
        y: Math.max(0.2, Math.min(height - 0.2, number(ear.y, 'listener y'))),
        angle: optionalNumber(ear.angle, 'listener angle', 0, -100, 100),
      },
    });
    if (raw.blurb !== undefined) room.blurb = text(raw.blurb, '', 240);
    if (raw.sceneKey !== undefined) room.sceneKey = text(raw.sceneKey, '', 40);
    if (raw.suggestedSource) room.suggestedSource = clampPoint(point(raw.suggestedSource, 'suggested source'), width, height);
    if (raw.suggestedTone !== undefined) room.suggestedTone = number(raw.suggestedTone, 'suggested tone', 10, LIMITS.maxFrequency);
    return { ok: true, room };
  } catch (error) {
    if (error instanceof RoomError) return { ok: false, error: error.message };
    throw error;
  }
}
