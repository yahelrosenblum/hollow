// A small drawing of a room for the room picker, made from the room's own objects with the
// same tracing the main view uses, so the picture is exactly the room you'll get.

import { traceObject } from '../app/overlay.js';
import { fitView, roomToScreen } from '../scene/layout.js';
import { HEAD_RADIUS } from '../scene/room.js';

const INK = {
  stone: 'rgba(170, 190, 212, 0.9)',
  mirror: 'rgba(214, 226, 240, 0.95)',
  wood: 'rgba(255, 176, 87, 0.85)',
  foam: 'rgba(92, 200, 255, 0.75)',
  glass: 'rgba(92, 200, 255, 0.95)',
  'heavy-gas': 'rgba(183, 166, 255, 0.85)',
  reed: 'rgba(255, 176, 87, 1)',
};

const FILLED = new Set(['rect', 'ellipse']);

export function drawRoomThumbnail(canvas, room) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 240;
  const height = canvas.clientHeight || 120;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const view = fitView(room, width, height, 10);

  const glow = ctx.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, width * 0.7);
  glow.addColorStop(0, '#0d1522');
  glow.addColorStop(1, '#05080e');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(142, 164, 189, 0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(view.x + 0.5, view.y + 0.5, view.width - 1, view.height - 1);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const o of room.objects) {
    if (o.type === 'opening') continue;
    const colour = o.type === 'window' ? INK.glass : (INK[o.material] ?? INK.stone);
    ctx.strokeStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 6;
    ctx.lineWidth = Math.max(1.2, Math.min(3, (o.thickness ?? 0.1) * view.scale));
    ctx.setLineDash(o.material === 'foam' ? [2, 2] : []);
    traceObject(ctx, view, o);
    // A `ring` is a hollow shell you stand inside, so only solid shapes are filled.
    if (FILLED.has(o.type) && !o.ring) {
      ctx.fillStyle = colour.replace(/[\d.]+\)$/, '0.16)');
      ctx.fill();
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  for (const s of room.speakers ?? []) {
    const c = roomToScreen(view, s);
    ctx.fillStyle = INK.wood;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const ear = roomToScreen(view, room.ear);
  ctx.fillStyle = '#fff4e0';
  ctx.shadowColor = 'rgba(255, 244, 224, 0.9)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(ear.x, ear.y, Math.max(2.5, HEAD_RADIUS * view.scale), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}
