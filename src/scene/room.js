// A room is plain data, in metres. Everything else (the grid, the screen, a saved file, a
// share link) is derived from it, and every edit returns a new room.

export const ROOM_SCHEMA = 1;

export const OBJECT_TYPES = Object.freeze(['wall', 'curve', 'rect', 'ellipse', 'door', 'window', 'opening']);

export const DEFAULT_WALL_THICKNESS = 0.2;
export const HEAD_RADIUS = 0.09;
export const EAR_OFFSET = 0.105;

let counter = 0;

export function newId(prefix = 'o') {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function createRoom(fields = {}) {
  return {
    schema: ROOM_SCHEMA,
    name: 'Untitled room',
    width: 12,
    height: 7,
    edges: 'closed',
    edgeMaterial: 'stone',
    airLoss: 1.5,
    lossless: false,
    objects: [],
    ear: { x: 8, y: 3.5, angle: 0 },
    speakers: [],
    ...fields,
  };
}

export function addObject(room, object) {
  return { ...room, objects: [...room.objects, { id: newId(), ...object }] };
}

export function updateObject(room, id, changes) {
  return {
    ...room,
    objects: room.objects.map((o) => (o.id === id ? { ...o, ...changes } : o)),
  };
}

export function removeObjects(room, ids) {
  const gone = new Set(ids);
  return { ...room, objects: room.objects.filter((o) => !gone.has(o.id)) };
}

export function setEar(room, ear) {
  return { ...room, ear: { ...room.ear, ...ear } };
}

export function earPositions(ear) {
  const c = Math.cos(ear.angle);
  const s = Math.sin(ear.angle);
  // The listener faces along `angle`, so the ears sit to either side.
  return {
    left: { x: ear.x + s * EAR_OFFSET, y: ear.y - c * EAR_OFFSET },
    right: { x: ear.x - s * EAR_OFFSET, y: ear.y + c * EAR_OFFSET },
  };
}

// Every point that defines an object, as a flat list. Used for bounds, snapping, and
// transforms, so a new object type only has to describe itself here.
function pointsOf(o) {
  switch (o.type) {
    case 'wall':
      return o.points;
    case 'curve':
      return [o.a, o.control, o.b];
    case 'rect':
    case 'ellipse':
      return [{ x: o.x, y: o.y }];
    case 'door':
      return [o.hinge];
    case 'window':
    case 'opening':
      return [o.a, o.b];
    default:
      return [];
  }
}

function withPoints(o, map) {
  switch (o.type) {
    case 'wall':
      return { ...o, points: o.points.map(map) };
    case 'curve':
      return { ...o, a: map(o.a), control: map(o.control), b: map(o.b) };
    case 'rect':
    case 'ellipse': {
      const p = map({ x: o.x, y: o.y });
      return { ...o, x: p.x, y: p.y };
    }
    case 'door':
      return { ...o, hinge: map(o.hinge) };
    case 'window':
    case 'opening':
      return { ...o, a: map(o.a), b: map(o.b) };
    default:
      return o;
  }
}

export function objectBounds(o) {
  const pad = (o.thickness ?? o.width ?? DEFAULT_WALL_THICKNESS) / 2;
  if (o.type === 'rect' || o.type === 'ellipse') {
    const reach = o.type === 'rect' ? Math.hypot(o.w, o.h) / 2 : Math.max(o.rx, o.ry);
    return { x0: o.x - reach, y0: o.y - reach, x1: o.x + reach, y1: o.y + reach };
  }
  if (o.type === 'door') {
    const r = o.length + pad;
    return { x0: o.hinge.x - r, y0: o.hinge.y - r, x1: o.hinge.x + r, y1: o.hinge.y + r };
  }
  const points = pointsOf(o);
  return {
    x0: Math.min(...points.map((p) => p.x)) - pad,
    y0: Math.min(...points.map((p) => p.y)) - pad,
    x1: Math.max(...points.map((p) => p.x)) + pad,
    y1: Math.max(...points.map((p) => p.y)) + pad,
  };
}

export function objectCentre(o) {
  const b = objectBounds(o);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

export function translateObject(o, dx, dy) {
  return withPoints(o, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function rotateObject(o, angle, centre = objectCentre(o)) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const moved = withPoints(o, (p) => ({
    x: centre.x + (p.x - centre.x) * c - (p.y - centre.y) * s,
    y: centre.y + (p.x - centre.x) * s + (p.y - centre.y) * c,
  }));
  if (o.type === 'rect' || o.type === 'ellipse') return { ...moved, rotation: (o.rotation ?? 0) + angle };
  if (o.type === 'door') return { ...moved, angle: o.angle + angle };
  return moved;
}

export function scaleObject(o, factor, centre = objectCentre(o)) {
  const moved = withPoints(o, (p) => ({
    x: centre.x + (p.x - centre.x) * factor,
    y: centre.y + (p.y - centre.y) * factor,
  }));
  if (o.type === 'rect') return { ...moved, w: o.w * factor, h: o.h * factor };
  if (o.type === 'ellipse') return { ...moved, rx: o.rx * factor, ry: o.ry * factor };
  if (o.type === 'door') return { ...moved, length: o.length * factor };
  return moved;
}

export function duplicateObject(o, dx = 0.4, dy = 0.4) {
  return { ...translateObject(o, dx, dy), id: newId() };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Like distanceToSegment, but with square ends: an opening cuts exactly as far along a wall as
// it was drawn. Rounded ends would leave a shut door with gaps either side of its leaf.
function distanceToSpan(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Infinity;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
  if (t < 0 || t > 1) return Infinity;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const curveCache = new WeakMap();

// Objects are never changed in place, so a curve's points can be worked out once. This is
// called for every grid cell near a curve, on every rasterise.
function cachedCurvePoints(o) {
  let points = curveCache.get(o);
  if (!points) {
    points = curvePoints(o);
    curveCache.set(o, points);
  }
  return points;
}

// A long stroke becomes its segments, so painting touches only cells near each one rather
// than every cell in the stroke's bounding box, testing every segment each time.
export function paintPieces(o) {
  if (o.type === 'wall' || o.type === 'curve') {
    const points = o.type === 'wall' ? o.points : cachedCurvePoints(o);
    const pieces = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
      pieces.push({
        type: 'wall', points: [points[i], points[i + 1]], thickness: o.thickness, material: o.material,
      });
    }
    return pieces;
  }
  return [o];
}

export function curvePoints(o, segments = 32) {
  const out = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const u = 1 - t;
    out.push({
      x: u * u * o.a.x + 2 * u * t * o.control.x + t * t * o.b.x,
      y: u * u * o.a.y + 2 * u * t * o.control.y + t * t * o.b.y,
    });
  }
  return out;
}

// `open` runs from 0 (shut) to 1 (fully swung), so a door can move through the positions in
// between while the solver runs. `true` and `false` are accepted as its two ends.
export function doorOpenness(o) {
  return Number(o.open) || 0;
}

export function doorLeaf(o) {
  const angle = o.angle + doorOpenness(o) * (o.swing ?? Math.PI / 2);
  return {
    a: o.hinge,
    b: { x: o.hinge.x + Math.cos(angle) * o.length, y: o.hinge.y + Math.sin(angle) * o.length },
  };
}

function polylineDistance(p, points) {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, points[i], points[i + 1]));
  }
  return best;
}

// Distance from a point to an object's body, negative or zero when inside. This one function
// decides both what the grid contains and what a click selects, so they cannot disagree.
export function signedDistance(o, p) {
  switch (o.type) {
    case 'wall':
      return polylineDistance(p, o.points) - o.thickness / 2;
    case 'curve':
      return polylineDistance(p, cachedCurvePoints(o)) - o.thickness / 2;
    case 'door': {
      const { a, b } = doorLeaf(o);
      return distanceToSegment(p, a, b) - o.thickness / 2;
    }
    case 'window':
      return distanceToSegment(p, o.a, o.b) - (o.thickness ?? 0.02) / 2;
    case 'opening':
      return distanceToSpan(p, o.a, o.b) - o.width / 2;
    case 'rect': {
      const c = Math.cos(-(o.rotation ?? 0));
      const s = Math.sin(-(o.rotation ?? 0));
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const lx = Math.abs(dx * c - dy * s) - o.w / 2;
      const ly = Math.abs(dx * s + dy * c) - o.h / 2;
      const outside = Math.hypot(Math.max(lx, 0), Math.max(ly, 0));
      const body = outside + Math.min(Math.max(lx, ly), 0);
      return o.ring ? Math.abs(body + o.ring / 2) - o.ring / 2 : body;
    }
    case 'ellipse': {
      const c = Math.cos(-(o.rotation ?? 0));
      const s = Math.sin(-(o.rotation ?? 0));
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const lx = (dx * c - dy * s) / o.rx;
      const ly = (dx * s + dy * c) / o.ry;
      const k = Math.hypot(lx, ly);
      // First-order distance estimate, accurate near the boundary, which is where it matters.
      // The exact centre has no gradient, so it takes the short radius instead.
      const body = k < 1e-6
        ? -Math.min(o.rx, o.ry)
        : (k * (k - 1)) / Math.hypot(lx / o.rx, ly / o.ry);
      return o.ring ? Math.abs(body + o.ring / 2) - o.ring / 2 : body;
    }
    default:
      return Infinity;
  }
}

// Topmost object at a point, within a tolerance in metres.
export function objectAt(room, p, tolerance = 0.12) {
  for (let i = room.objects.length - 1; i >= 0; i -= 1) {
    const o = room.objects[i];
    if (signedDistance(o, p) <= tolerance) return o;
  }
  return null;
}
