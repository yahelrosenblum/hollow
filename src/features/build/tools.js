// The drawing tools. Each one turns pointer gestures into ordinary room objects. Nothing here
// touches the simulation directly: commit a room, and the solver gets it.

import {
  DEFAULT_WALL_THICKNESS, addObject, objectAt, objectBounds, objectCentre, rotateObject,
  scaleObject, translateObject, updateObject,
} from '../../scene/room.js';
import { roomToScreen } from '../../scene/layout.js';
import { traceObject } from '../../app/overlay.js';
import {
  constrainAngle, pathLength, simplifyStroke, snapPoint,
} from './snap.js';

const HANDLE_PIXELS = 7;
const MIN_DRAG_METRES = 0.03;

function label(ctx, text, x, y) {
  ctx.font = '11px "IBM Plex Mono", monospace';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(11,16,21,0.85)';
  ctx.fillRect(x + 6, y - 15, w + 8, 16);
  ctx.fillStyle = '#ece6d8';
  ctx.fillText(text, x + 10, y - 3);
}

function preview(ctx, view, object) {
  ctx.setLineDash([]);
  ctx.strokeStyle = '#ece6d8';
  ctx.lineWidth = 1.5;
  traceObject(ctx, view, object);
  ctx.stroke();
}

// Shared by the tools below: snap, read settings, commit.
class DrawTool {
  constructor(build) {
    this.build = build;
    this.app = build.app;
    this.wantsHover = true;
    this.cursor = 'crosshair';
  }

  snap(point, event) {
    const { settings } = this.build;
    const result = snapPoint(this.app.room, point, {
      grid: settings.gridStep,
      snapGrid: settings.snap,
      snapEnds: settings.snap,
    });
    if (this.anchor && event?.shiftKey) return constrainAngle(this.anchor, result);
    return result;
  }

  commitObject(object) {
    const room = addObject(this.app.room, object);
    this.app.commit(room);
    this.app.announce(`Added ${object.type}`);
    return room.objects[room.objects.length - 1];
  }

  onDeactivate() {
    this.cancel?.();
  }
}

// Click point after point; double-click or press Enter to finish.
export class WallTool extends DrawTool {
  constructor(build) {
    super(build);
    this.points = [];
    this.hover = null;
  }

  get anchor() {
    return this.points[this.points.length - 1];
  }

  down(point, event) {
    const p = this.snap(point, event);
    const last = this.anchor;
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > MIN_DRAG_METRES) {
      this.points = [...this.points, { x: p.x, y: p.y }];
    }
  }

  move(point, event) {
    this.hover = this.snap(point, event);
  }

  doubleClick() {
    this.finish();
  }

  keyboardAct(point) {
    this.down(point);
  }

  finish() {
    if (this.points.length >= 2) {
      const { settings } = this.build;
      this.commitObject({
        type: 'wall',
        points: this.points,
        thickness: settings.thickness,
        material: settings.material,
      });
    }
    this.points = [];
    this.hover = null;
    this.app.overlay.dirty = true;
  }

  cancel() {
    this.points = [];
    this.hover = null;
  }

  draw(ctx, view) {
    const path = this.hover && this.points.length ? [...this.points, this.hover] : this.points;
    if (path.length > 1) {
      preview(ctx, view, { type: 'wall', points: path });
      const end = roomToScreen(view, path[path.length - 1]);
      label(ctx, `${pathLength(path).toFixed(2)} m`, end.x, end.y);
    }
    if (this.hover) {
      const s = roomToScreen(view, this.hover);
      ctx.strokeStyle = '#ece6d8';
      ctx.strokeRect(s.x - 3, s.y - 3, 6, 6);
    }
  }
}

export class FreehandTool extends DrawTool {
  constructor(build) {
    super(build);
    this.points = null;
  }

  down(point) {
    this.points = [point];
  }

  move(point, _event, dragging) {
    if (dragging && this.points) this.points = [...this.points, point];
  }

  up() {
    if (this.points && this.points.length > 1) {
      const { settings } = this.build;
      this.commitObject({
        type: 'wall',
        points: simplifyStroke(this.points),
        thickness: settings.thickness,
        material: settings.material,
      });
    }
    this.points = null;
  }

  cancel() {
    this.points = null;
  }

  draw(ctx, view) {
    if (this.points && this.points.length > 1) preview(ctx, view, { type: 'wall', points: this.points });
  }
}

// Press at one end, release at the other, and the wall bows toward a third click.
export class CurveTool extends DrawTool {
  constructor(build) {
    super(build);
    this.stage = 0;
    this.a = null;
    this.b = null;
    this.control = null;
  }

  down(point, event) {
    const p = this.snap(point, event);
    if (this.stage === 0) {
      this.a = p;
      this.b = p;
      this.control = p;
      this.stage = 1;
    } else if (this.stage === 2) {
      const { settings } = this.build;
      this.commitObject({
        type: 'curve',
        a: { x: this.a.x, y: this.a.y },
        control: { x: p.x, y: p.y },
        b: { x: this.b.x, y: this.b.y },
        thickness: settings.thickness,
        material: settings.material,
      });
      this.cancel();
    }
  }

  move(point, event) {
    const p = this.snap(point, event);
    if (this.stage === 1) {
      this.b = p;
      this.control = { x: (this.a.x + p.x) / 2, y: (this.a.y + p.y) / 2 };
    } else if (this.stage === 2) {
      this.control = p;
    }
  }

  up() {
    if (this.stage === 1) {
      const moved = Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y);
      if (moved > MIN_DRAG_METRES) this.stage = 2;
      else if (!this.tapped) this.tapped = true;
    }
  }

  keyboardAct(point) {
    if (this.stage === 0) this.down(point);
    else if (this.stage === 1) {
      this.b = point;
      this.stage = 2;
    } else this.down(point);
  }

  cancel() {
    this.stage = 0;
    this.a = null;
    this.b = null;
    this.control = null;
    this.tapped = false;
  }

  draw(ctx, view) {
    if (this.stage > 0) preview(ctx, view, { type: 'curve', a: this.a, b: this.b, control: this.control });
  }
}

// Press and drag out a shape from one corner to the other.
export class ShapeTool extends DrawTool {
  constructor(build, kind) {
    super(build);
    this.kind = kind;
    this.start = null;
    this.end = null;
  }

  object() {
    const { settings } = this.build;
    const x = (this.start.x + this.end.x) / 2;
    const y = (this.start.y + this.end.y) / 2;
    const w = Math.abs(this.end.x - this.start.x);
    const h = Math.abs(this.end.y - this.start.y);
    const shape = this.kind === 'rect'
      ? { type: 'rect', x, y, w, h, material: settings.material }
      : { type: 'ellipse', x, y, rx: w / 2, ry: h / 2, material: settings.material };
    return settings.hollow ? { ...shape, ring: settings.thickness } : shape;
  }

  down(point, event) {
    this.start = this.snap(point, event);
    this.end = this.start;
  }

  move(point, event, dragging) {
    if (dragging && this.start) this.end = this.snap(point, event);
  }

  up() {
    if (this.start && Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) > MIN_DRAG_METRES) {
      this.commitObject(this.object());
    }
    this.start = null;
    this.end = null;
  }

  keyboardAct(point) {
    if (!this.start) {
      this.start = point;
      this.end = point;
    } else {
      this.end = point;
      this.up();
    }
  }

  cancel() {
    this.start = null;
    this.end = null;
  }

  draw(ctx, view) {
    if (!this.start) return;
    const object = this.object();
    preview(ctx, view, object);
    const s = roomToScreen(view, this.end);
    label(ctx, `${Math.abs(this.end.x - this.start.x).toFixed(2)} × ${Math.abs(this.end.y - this.start.y).toFixed(2)} m`, s.x, s.y);
  }
}

// Press at one end, drag to the other. Used for doors, windows, openings and the tape measure.
export class SpanTool extends DrawTool {
  constructor(build, kind) {
    super(build);
    this.kind = kind;
    this.a = null;
    this.b = null;
    this.stored = null;
  }

  get anchor() {
    return this.a;
  }

  down(point, event) {
    this.a = this.snap(point, event);
    this.b = this.a;
    this.stored = null;
  }

  move(point, event, dragging) {
    if (dragging && this.a) this.b = this.snap(point, event);
  }

  up() {
    if (!this.a) return;
    const length = Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y);
    if (length > MIN_DRAG_METRES) this.place(length);
    if (this.kind !== 'measure') {
      this.a = null;
      this.b = null;
    }
  }

  place(length) {
    const a = { x: this.a.x, y: this.a.y };
    const b = { x: this.b.x, y: this.b.y };
    if (this.kind === 'door') {
      this.commitObject({
        type: 'door',
        hinge: a,
        length,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        swing: Math.PI / 2,
        open: 0,
        thickness: 0.08,
        frame: this.build.settings.thickness + 0.1,
        material: 'wood',
      });
    } else if (this.kind === 'window') {
      this.commitObject({ type: 'window', a, b, open: false });
    } else if (this.kind === 'opening') {
      this.commitObject({ type: 'opening', a, b, width: this.build.settings.thickness + 0.1 });
    } else if (this.kind === 'measure') {
      this.stored = { a, b, length };
      this.app.announce(`${length.toFixed(2)} metres`);
    }
  }

  keyboardAct(point) {
    if (!this.a) {
      this.a = point;
      this.b = point;
    } else {
      this.b = point;
      this.up();
    }
  }

  cancel() {
    this.a = null;
    this.b = null;
    this.stored = null;
  }

  draw(ctx, view) {
    const from = this.a;
    const to = this.b;
    if (!from || !to) return;
    const sa = roomToScreen(view, from);
    const sb = roomToScreen(view, to);
    ctx.strokeStyle = '#ece6d8';
    ctx.lineWidth = 1;
    ctx.setLineDash(this.kind === 'measure' ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `${Math.hypot(to.x - from.x, to.y - from.y).toFixed(2)} m`, sb.x, sb.y);
  }
}

// Selection: click to select, drag to move, corner handle to resize, top handle to rotate.
export class SelectTool {
  constructor(build) {
    this.build = build;
    this.app = build.app;
    this.drag = null;
    this.cursor = 'default';
    this.group = 0;
  }

  get selected() {
    return this.build.selectedObject();
  }

  handles(object, view) {
    const b = objectBounds(object);
    const corner = roomToScreen(view, { x: b.x1, y: b.y1 });
    const top = roomToScreen(view, { x: (b.x0 + b.x1) / 2, y: b.y0 });
    return { scale: corner, rotate: { x: top.x, y: top.y - 18 } };
  }

  hitHandle(point) {
    const object = this.selected;
    if (!object) return null;
    const { view } = this.app;
    const s = roomToScreen(view, point);
    const { scale, rotate } = this.handles(object, view);
    if (Math.hypot(s.x - scale.x, s.y - scale.y) <= HANDLE_PIXELS + 4) return 'scale';
    if (Math.hypot(s.x - rotate.x, s.y - rotate.y) <= HANDLE_PIXELS + 4) return 'rotate';
    return null;
  }

  down(point) {
    const handle = this.hitHandle(point);
    this.group += 1;
    if (handle) {
      const object = this.selected;
      const centre = objectCentre(object);
      this.drag = {
        kind: handle,
        original: object,
        centre,
        startAngle: Math.atan2(point.y - centre.y, point.x - centre.x),
        startDistance: Math.max(0.05, Math.hypot(point.x - centre.x, point.y - centre.y)),
      };
      return;
    }
    const tolerance = 10 / this.app.view.scale;
    const hit = objectAt(this.app.room, point, tolerance);
    // Challenges fix some walls in place: they're part of the problem to be solved.
    if (hit?.locked) {
      this.build.select(null);
      this.app.toast('That wall is part of the challenge, so it stays where it is.');
      return;
    }
    this.build.select(hit?.id ?? null);
    if (hit) this.drag = { kind: 'move', original: hit, start: point };
  }

  move(point, _event, dragging) {
    if (!dragging || !this.drag) return;
    const { drag, build, app } = this;
    let next = drag.original;
    if (drag.kind === 'move') {
      let dx = point.x - drag.start.x;
      let dy = point.y - drag.start.y;
      if (build.settings.snap) {
        const step = build.settings.gridStep;
        dx = Math.round(dx / step) * step;
        dy = Math.round(dy / step) * step;
      }
      next = translateObject(drag.original, dx, dy);
    } else if (drag.kind === 'rotate') {
      const angle = Math.atan2(point.y - drag.centre.y, point.x - drag.centre.x);
      next = rotateObject(drag.original, angle - drag.startAngle, drag.centre);
    } else if (drag.kind === 'scale') {
      const distance = Math.hypot(point.x - drag.centre.x, point.y - drag.centre.y);
      next = scaleObject(drag.original, Math.max(0.05, distance / drag.startDistance), drag.centre);
    }
    app.commit(updateObject(app.room, drag.original.id, next), { group: `select-${this.group}` });
    build.refreshSelection();
  }

  up() {
    this.drag = null;
  }

  keyboardAct(point) {
    const hit = objectAt(this.app.room, point, 0.2);
    this.build.select(hit?.id ?? null);
  }

  draw(ctx, view) {
    const object = this.selected;
    if (!object) return;
    ctx.strokeStyle = '#6fb0d6';
    ctx.lineWidth = 2;
    traceObject(ctx, view, object);
    ctx.stroke();
    const b = objectBounds(object);
    const a = roomToScreen(view, { x: b.x0, y: b.y0 });
    const c = roomToScreen(view, { x: b.x1, y: b.y1 });
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.setLineDash([]);
    const { scale, rotate } = this.handles(object, view);
    ctx.fillStyle = '#0b1015';
    ctx.fillRect(scale.x - HANDLE_PIXELS / 2, scale.y - HANDLE_PIXELS / 2, HANDLE_PIXELS, HANDLE_PIXELS);
    ctx.strokeRect(scale.x - HANDLE_PIXELS / 2, scale.y - HANDLE_PIXELS / 2, HANDLE_PIXELS, HANDLE_PIXELS);
    ctx.beginPath();
    ctx.moveTo((a.x + c.x) / 2, a.y);
    ctx.lineTo(rotate.x, rotate.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rotate.x, rotate.y, HANDLE_PIXELS / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

export { DEFAULT_WALL_THICKNESS };
