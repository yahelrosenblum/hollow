// Maps a room onto a rectangle of the screen. The worker uses it to draw the field and the
// interface uses it to draw over the field, so the two always line up.

// `inset` is the part of each edge covered by controls floating over the field, so the room is
// centred in what can actually be seen.
export function fitView(room, width, height, padding = 16, inset = null) {
  const left = inset?.left ?? 0;
  const right = inset?.right ?? 0;
  const top = inset?.top ?? 0;
  const bottom = inset?.bottom ?? 0;
  const availableW = Math.max(1, width - left - right - padding * 2);
  const availableH = Math.max(1, height - top - bottom - padding * 2);
  const scale = Math.min(availableW / room.width, availableH / room.height);
  return {
    scale,
    x: left + padding + (availableW - room.width * scale) / 2,
    y: top + padding + (availableH - room.height * scale) / 2,
    width: room.width * scale,
    height: room.height * scale,
  };
}

export function roomToScreen(view, point) {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale };
}

export function screenToRoom(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function insideRoom(room, point) {
  return point.x >= 0 && point.y >= 0 && point.x <= room.width && point.y <= room.height;
}

export function clampToRoom(room, point, margin = 0) {
  return {
    x: Math.max(margin, Math.min(room.width - margin, point.x)),
    y: Math.max(margin, Math.min(room.height - margin, point.y)),
  };
}
