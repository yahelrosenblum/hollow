// Snapping for precise drawing. Pure, so it can be tested without a screen.

import { curvePoints, doorLeaf } from '../../scene/room.js';

const ANGLE_STEP = Math.PI / 12;

export function endpoints(object) {
  switch (object.type) {
    case 'wall':
      return [object.points[0], object.points[object.points.length - 1]];
    case 'curve':
      return [object.a, object.b];
    case 'window':
    case 'opening':
      return [object.a, object.b];
    case 'door': {
      const leaf = doorLeaf(object);
      return [leaf.a, leaf.b];
    }
    default:
      return [];
  }
}

// Prefers an existing endpoint within reach (so walls actually meet), then the grid.
export function snapPoint(room, point, { grid = 0.25, reach = 0.2, snapGrid = true, snapEnds = true, ignore = null } = {}) {
  if (snapEnds) {
    let best = null;
    let bestDistance = reach;
    for (const object of room.objects) {
      if (object.id !== ignore) {
        for (const end of endpoints(object)) {
          const d = Math.hypot(end.x - point.x, end.y - point.y);
          if (d < bestDistance) {
            best = end;
            bestDistance = d;
          }
        }
      }
    }
    if (best) return { x: best.x, y: best.y, snapped: 'end' };
  }
  if (snapGrid) {
    return {
      x: Math.round(point.x / grid) * grid,
      y: Math.round(point.y / grid) * grid,
      snapped: 'grid',
    };
  }
  return { x: point.x, y: point.y, snapped: null };
}

// Holding Shift while drawing keeps a line to multiples of 15 degrees.
export function constrainAngle(from, to) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / ANGLE_STEP) * ANGLE_STEP;
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

export function pathLength(points) {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

export function curveLength(object) {
  return pathLength(curvePoints(object));
}

// Drops points closer together than a freehand stroke needs, keeping the shape.
export function simplifyStroke(points, tolerance = 0.03) {
  if (points.length < 3) return points;
  const keep = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const last = keep[keep.length - 1];
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= tolerance) keep.push(points[i]);
  }
  keep.push(points[points.length - 1]);
  return keep;
}
