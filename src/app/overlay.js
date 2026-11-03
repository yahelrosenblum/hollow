// Linework over the field: the room as drawn, the listener, speakers, and whatever the active
// tool wants to show. It only ever reads room data; the field underneath comes from the solver.

import { earPositions, curvePoints, doorLeaf, HEAD_RADIUS } from '../scene/room.js';
import { roomToScreen } from '../scene/layout.js';

const COLOURS = {
  line: 'rgba(238, 240, 242, 0.7)',
  faint: 'rgba(238, 240, 242, 0.22)',
  grid: 'rgba(238, 240, 242, 0.05)',
  gridMajor: 'rgba(238, 240, 242, 0.11)',
  border: 'rgba(142, 164, 189, 0.35)',
  paper: '#eef0f2',
  ink: '#04070c',
  warm: '#ffb057',
  cool: '#5cc8ff',
};

const MATERIAL_DASH = {
  stone: [],
  mirror: [],
  wood: [],
  foam: [3, 3],
  glass: [],
  'heavy-gas': [1, 4],
  reed: [],
};

export function drawGrid(ctx, room, view, step = 0.5) {
  ctx.lineWidth = 1;
  const majorEvery = Math.round(1 / step);
  let index = 0;
  for (let x = 0; x <= room.width + 1e-6; x += step) {
    ctx.strokeStyle = index % majorEvery === 0 ? COLOURS.gridMajor : COLOURS.grid;
    const sx = Math.round(view.x + x * view.scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, view.y);
    ctx.lineTo(sx, view.y + view.height);
    ctx.stroke();
    index += 1;
  }
  index = 0;
  for (let y = 0; y <= room.height + 1e-6; y += step) {
    ctx.strokeStyle = index % majorEvery === 0 ? COLOURS.gridMajor : COLOURS.grid;
    const sy = Math.round(view.y + y * view.scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(view.x, sy);
    ctx.lineTo(view.x + view.width, sy);
    ctx.stroke();
    index += 1;
  }
}

function polyline(ctx, view, points) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const s = roomToScreen(view, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
}

function ellipseOutline(ctx, view, o, rx, ry) {
  const c = roomToScreen(view, o);
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0, rx * view.scale), Math.max(0, ry * view.scale), o.rotation ?? 0, 0, Math.PI * 2);
}

function rectOutline(ctx, view, o, w, h) {
  const c = roomToScreen(view, o);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(o.rotation ?? 0);
  ctx.beginPath();
  ctx.rect((-w / 2) * view.scale, (-h / 2) * view.scale, w * view.scale, h * view.scale);
  ctx.restore();
}

export function traceObject(ctx, view, o) {
  switch (o.type) {
    case 'wall':
      polyline(ctx, view, o.points);
      break;
    case 'curve':
      polyline(ctx, view, curvePoints(o));
      break;
    case 'window':
    case 'opening':
      polyline(ctx, view, [o.a, o.b]);
      break;
    case 'door': {
      const { a, b } = doorLeaf(o);
      polyline(ctx, view, [a, b]);
      break;
    }
    case 'rect':
      rectOutline(ctx, view, o, o.w, o.h);
      break;
    case 'ellipse':
      ellipseOutline(ctx, view, o, o.rx, o.ry);
      break;
    default:
      break;
  }
}

function drawDoorSwing(ctx, view, o) {
  const c = roomToScreen(view, o.hinge);
  const start = o.angle;
  const end = o.angle + (o.swing ?? Math.PI / 2);
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = COLOURS.faint;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c.x, c.y, o.length * view.scale, start, end);
  ctx.stroke();
  ctx.restore();
}

function drawObject(ctx, view, o) {
  ctx.setLineDash(MATERIAL_DASH[o.material] ?? []);
  ctx.strokeStyle = COLOURS.line;
  ctx.lineWidth = 1;
  if (o.type === 'opening') {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLOURS.faint;
  } else if (o.type === 'door') {
    drawDoorSwing(ctx, view, o);
    ctx.setLineDash([]);
    ctx.strokeStyle = COLOURS.line;
    ctx.lineWidth = 2;
  } else if (o.type === 'window') {
    ctx.strokeStyle = o.open ? COLOURS.faint : COLOURS.cool;
    ctx.lineWidth = o.open ? 1 : 2;
    if (o.open) ctx.setLineDash([2, 4]);
  } else if (o.type === 'wall' || o.type === 'curve') {
    // Walls are drawn along their centre line. The hatched cells beneath them are the real
    // thickness the solver sees.
    ctx.strokeStyle = COLOURS.faint;
  }
  traceObject(ctx, view, o);
  ctx.stroke();
  ctx.setLineDash([]);
}

function halo(ctx, x, y, radius, colour) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, colour);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// You: a soft light with a ring, a pointer for where you face, and a dot at each ear.
function drawListener(ctx, view, ear) {
  const c = roomToScreen(view, ear);
  const r = Math.max(7, HEAD_RADIUS * view.scale);
  ctx.save();
  halo(ctx, c.x, c.y, r * 3.2, 'rgba(255, 244, 224, 0.22)');
  ctx.fillStyle = 'rgba(8, 12, 18, 0.85)';
  ctx.strokeStyle = COLOURS.paper;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(255, 244, 224, 0.9)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  const a = ear.angle;
  const tip = { x: c.x + Math.cos(a) * (r + 9), y: c.y + Math.sin(a) * (r + 9) };
  const base = (side) => ({
    x: c.x + Math.cos(a) * (r + 2) + Math.cos(a + side * Math.PI / 2) * 4.5,
    y: c.y + Math.sin(a) * (r + 2) + Math.sin(a + side * Math.PI / 2) * 4.5,
  });
  ctx.fillStyle = COLOURS.paper;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(base(1).x, base(1).y);
  ctx.lineTo(base(-1).x, base(-1).y);
  ctx.closePath();
  ctx.fill();
  const { left, right } = earPositions(ear);
  for (const p of [left, right]) {
    const s = roomToScreen(view, p);
    const away = Math.hypot(s.x - c.x, s.y - c.y) || 1;
    const k = r / away;
    ctx.beginPath();
    ctx.arc(c.x + (s.x - c.x) * k, c.y + (s.y - c.y) * k, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS.warm;
    ctx.fill();
  }
  ctx.restore();
}

function drawSpeaker(ctx, view, speaker, selected) {
  const c = roomToScreen(view, speaker);
  ctx.save();
  if (speaker.on) halo(ctx, c.x, c.y, 26, 'rgba(255, 176, 87, 0.35)');
  ctx.translate(c.x, c.y);
  ctx.strokeStyle = speaker.on ? COLOURS.warm : COLOURS.faint;
  ctx.fillStyle = 'rgba(8, 12, 18, 0.9)';
  ctx.lineWidth = selected ? 2.5 : 1.75;
  ctx.shadowColor = speaker.on ? COLOURS.warm : 'transparent';
  ctx.shadowBlur = speaker.on ? 10 : 0;
  ctx.beginPath();
  ctx.roundRect(-8, -8, 16, 16, 4);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = speaker.on ? COLOURS.warm : COLOURS.faint;
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = COLOURS.paper;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layers = [];
    this.marks = [];
    this.selectedSpeaker = null;
    this.showGrid = false;
    this.gridStep = 0.5;
    this.dirty = true;
  }

  addLayer(draw) {
    this.layers = [...this.layers, draw];
    return () => {
      this.layers = this.layers.filter((l) => l !== draw);
    };
  }

  mark(point) {
    this.marks = [...this.marks, { point, born: performance.now() }];
    this.dirty = true;
  }

  // Redraws only when something changed, and while marks are fading.
  draw(room, view, dpr, cursor) {
    const { ctx, canvas } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.strokeStyle = COLOURS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(view.x - 0.5, view.y - 0.5, view.width + 1, view.height + 1, 2);
    ctx.stroke();
    if (this.showGrid) drawGrid(ctx, room, view, this.gridStep);
    for (const o of room.objects) drawObject(ctx, view, o);
    for (const s of room.speakers ?? []) drawSpeaker(ctx, view, s, s.id === this.selectedSpeaker);
    drawListener(ctx, view, room.ear);
    this.drawMarks(view);
    for (const layer of this.layers) layer(ctx, view, room);
    if (cursor) this.drawCursor(view, cursor);
  }

  drawMarks(view) {
    const { ctx } = this;
    const now = performance.now();
    this.marks = this.marks.filter((m) => now - m.born < 700);
    // Only where you tapped. The wave itself is the field underneath, never drawn here.
    for (const m of this.marks) {
      const age = (now - m.born) / 700;
      const c = roomToScreen(view, m.point);
      ctx.fillStyle = `rgba(255, 244, 224, ${0.9 * (1 - age)})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.5 + age * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawCursor(view, cursor) {
    const { ctx } = this;
    const c = roomToScreen(view, cursor);
    ctx.strokeStyle = COLOURS.paper;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
    ctx.moveTo(c.x - 14, c.y);
    ctx.lineTo(c.x - 6, c.y);
    ctx.moveTo(c.x + 6, c.y);
    ctx.lineTo(c.x + 14, c.y);
    ctx.moveTo(c.x, c.y - 14);
    ctx.lineTo(c.x, c.y - 6);
    ctx.moveTo(c.x, c.y + 6);
    ctx.lineTo(c.x, c.y + 14);
    ctx.stroke();
  }
}

export { COLOURS };
