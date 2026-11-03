// Built-in scenes. Each is an ordinary room, built with the same objects a person can draw,
// and each one shows something that emerges from the wave equation.

import { addObject, createRoom, curvePoints } from './room.js';

const pt = (x, y) => ({ x, y });

function build(fields, objects = []) {
  return objects.reduce((room, object) => addObject(room, object), createRoom(fields));
}

function wall(points, material = 'stone', thickness = 0.25) {
  return { type: 'wall', points, material, thickness };
}

function column(x, y, r = 0.28, material = 'stone') {
  return { type: 'ellipse', x, y, rx: r, ry: r, material };
}

function cathedral() {
  const columns = [];
  for (let i = 0; i < 6; i += 1) {
    const x = 3.1 + i * 1.75;
    columns.push(column(x, 2.4), column(x, 6.6));
  }
  // The apse closes the east end with a real curved wall.
  const apse = {
    type: 'curve', a: pt(15, 1), control: pt(19.4, 4.5), b: pt(15, 8), material: 'stone', thickness: 0.3,
  };
  return build({
    name: 'Cathedral',
    blurb: 'Stone, columns and an apse. Clap, and listen to how long it stays.',
    width: 18,
    height: 9,
    airLoss: 0.6,
    ear: { x: 11, y: 4.5, angle: Math.PI },
  }, [
    ...columns,
    apse,
    { type: 'rect', x: 16.9, y: 0.5, w: 2.4, h: 1, material: 'stone' },
    { type: 'rect', x: 16.9, y: 8.5, w: 2.4, h: 1, material: 'stone' },
    { type: 'rect', x: 17.9, y: 4.5, w: 0.4, h: 9, material: 'stone' },
  ]);
}

function whisperingGallery() {
  const rx = 6;
  const ry = 3.3;
  const focus = Math.sqrt(rx * rx - ry * ry);
  return build({
    name: 'Whispering gallery',
    blurb: 'An ellipse sends every sound from one focus to the other. Listen from the far focus, then step aside.',
    width: 14,
    height: 8,
    airLoss: 1.2,
    edgeMaterial: 'stone',
    ear: { x: 7 + focus, y: 4, angle: Math.PI },
    suggestedSource: { x: 7 - focus, y: 4 },
  }, [
    { type: 'ellipse', x: 7, y: 4, rx: rx + 0.15, ry: ry + 0.15, ring: 0.3, material: 'stone' },
    // Everything outside the ellipse is solid, so no sound travels around it.
    { type: 'rect', x: 0.4, y: 4, w: 0.8, h: 8, material: 'stone' },
    { type: 'rect', x: 13.6, y: 4, w: 0.8, h: 8, material: 'stone' },
    // A screen between the foci stops the direct sound, so what arrives came via the walls.
    wall([pt(7, 2.6), pt(7, 5.4)], 'stone', 0.25),
  ]);
}

function cave() {
  const north = [pt(0, 2.2), pt(2, 1.2), pt(4.2, 2.4), pt(6, 1), pt(8.5, 2.1), pt(10.5, 0.9), pt(12, 2.6), pt(14, 1.6)];
  const south = [pt(0, 5.6), pt(1.8, 7), pt(4, 5.2), pt(6.4, 6.9), pt(8.2, 5.4), pt(10.8, 7.2), pt(12.4, 5.8), pt(14, 6.6)];
  return build({
    name: 'Cave',
    blurb: 'A long irregular tunnel with a deep pocket. Echoes arrive scattered, and bass lingers.',
    width: 14,
    height: 8,
    airLoss: 1,
    ear: { x: 10.5, y: 3.9, angle: Math.PI },
    edges: 'closed',
  }, [
    wall(north, 'stone', 0.4),
    wall(south, 'stone', 0.4),
    { type: 'rect', x: 7, y: 0, w: 14, h: 1.8, material: 'stone' },
    { type: 'rect', x: 7, y: 8, w: 14, h: 1.6, material: 'stone' },
    column(6.3, 3.9, 0.5),
    column(8.4, 4.6, 0.3),
  ]);
}

function organPipe() {
  return build({
    name: 'Organ pipe',
    blurb: 'A reed at the closed end of a pipe. Hold to blow. The note comes from the pipe\'s length: in Build, drag the open ends of its two long walls. Shorter sounds higher.',
    width: 6,
    height: 3,
    airLoss: 0.8,
    edges: 'open',
    ear: { x: 2.8, y: 1.5, angle: Math.PI },
  }, [
    wall([pt(1, 1.42), pt(1.6, 1.42)], 'mirror', 0.04),
    wall([pt(1, 1.58), pt(1.6, 1.58)], 'mirror', 0.04),
    wall([pt(0.93, 1.42), pt(0.93, 1.58)], 'mirror', 0.14),
    { type: 'rect', x: 1.1, y: 1.5, w: 0.2, h: 0.16, material: 'reed' },
  ]);
}

function doubleSlit() {
  return build({
    name: 'Double slit',
    blurb: 'A tone passes two gaps and makes bands of loud and quiet. Walk across the far side and hear them.',
    width: 12,
    height: 7,
    airLoss: 1.5,
    edges: 'open',
    ear: { x: 9.5, y: 3.5, angle: Math.PI },
    suggestedSource: { x: 2, y: 3.5 },
    suggestedTone: 1100,
  }, [
    wall([pt(4.5, 0), pt(4.5, 2.95)], 'stone', 0.2),
    wall([pt(4.5, 3.25), pt(4.5, 3.75)], 'stone', 0.2),
    wall([pt(4.5, 4.05), pt(4.5, 7)], 'stone', 0.2),
  ]);
}

function acousticLens() {
  return build({
    name: 'Acoustic lens',
    blurb: 'A balloon of heavy gas slows sound and bends it to a focus, the way glass bends light.',
    width: 12,
    height: 7,
    airLoss: 1.5,
    edges: 'open',
    ear: { x: 9.6, y: 3.5, angle: Math.PI },
    suggestedSource: { x: 1.4, y: 3.5 },
    suggestedTone: 1400,
  }, [
    { type: 'ellipse', x: 5.2, y: 3.5, rx: 0.7, ry: 2.2, material: 'heavy-gas' },
  ]);
}

function anechoic() {
  const wedges = [];
  for (let x = 0.35; x < 10; x += 0.7) {
    wedges.push({ type: 'rect', x, y: 0.5, w: 0.5, h: 1, material: 'foam' });
    wedges.push({ type: 'rect', x, y: 5.5, w: 0.5, h: 1, material: 'foam' });
  }
  for (let y = 1.4; y < 5; y += 0.7) {
    wedges.push({ type: 'rect', x: 0.5, y, w: 1, h: 0.5, material: 'foam' });
    wedges.push({ type: 'rect', x: 9.5, y, w: 1, h: 0.5, material: 'foam' });
  }
  return build({
    name: 'Dead room',
    blurb: 'Foam on every surface. Highs vanish almost at once, while the lowest notes still get through it.',
    width: 10,
    height: 6,
    airLoss: 3,
    ear: { x: 6.2, y: 3, angle: Math.PI },
  }, wedges);
}

function timeMirror() {
  return build({
    name: 'Time mirror',
    blurb: 'Perfect walls and no loss, so the equations can run backward. Clap, wait, then press Rewind.',
    width: 9,
    height: 6,
    lossless: true,
    airLoss: 0,
    edgeMaterial: 'mirror',
    ear: { x: 6.6, y: 3, angle: Math.PI },
    suggestedSource: { x: 2.4, y: 2.6 },
  }, [
    wall([pt(3.6, 0), pt(3.6, 3.4)], 'mirror', 0.2),
    wall([pt(5.7, 6), pt(5.7, 2.8)], 'mirror', 0.2),
    { type: 'ellipse', x: 7.3, y: 1.3, rx: 0.5, ry: 0.5, material: 'mirror' },
    { type: 'ellipse', x: 1.6, y: 4.6, rx: 0.65, ry: 0.65, material: 'mirror' },
  ]);
}

function adjoiningRooms() {
  return build({
    name: 'Next door',
    blurb: 'Two rooms and a door. Close it and listen: the bass bends around, and the highs stay behind.',
    width: 12,
    height: 7,
    airLoss: 1.5,
    ear: { x: 9.5, y: 3.5, angle: Math.PI },
    suggestedSource: { x: 3, y: 3.5 },
  }, [
    wall([pt(6, 0), pt(6, 2.9)], 'stone', 0.25),
    wall([pt(6, 4.1), pt(6, 7)], 'stone', 0.25),
    {
      type: 'door', hinge: pt(6, 2.9), length: 1.2, angle: Math.PI / 2, swing: Math.PI / 2, open: true, thickness: 0.08, frame: 0.3, material: 'wood',
    },
    { type: 'rect', x: 1, y: 1, w: 1.6, h: 0.8, material: 'foam' },
  ]);
}

function corridor() {
  return build({
    name: 'Flutter corridor',
    blurb: 'Two parallel stone walls and nothing else. Clap between them and hear the zipping echo that makes architects avoid parallel walls.',
    width: 14,
    height: 5,
    airLoss: 0.8,
    edges: 'open',
    ear: { x: 9, y: 2.5, angle: Math.PI },
    suggestedSource: { x: 5, y: 2.5 },
  }, [
    wall([pt(1, 1.5), pt(13, 1.5)], 'stone', 0.25),
    wall([pt(1, 3.5), pt(13, 3.5)], 'stone', 0.25),
  ]);
}

function bottle() {
  return build({
    name: 'Bottle',
    blurb: 'A cavity with a narrow neck: a Helmholtz resonator, the note you get by blowing across a bottle. Clap beside it, or send it a tone from the Spectrum panel.',
    width: 8,
    height: 5,
    airLoss: 1,
    edges: 'open',
    ear: { x: 6.4, y: 2.5, angle: Math.PI },
    suggestedSource: { x: 4.6, y: 2.5 },
  }, [
    { type: 'ellipse', x: 1.9, y: 2.5, rx: 1.2, ry: 1, ring: 0.2, material: 'stone' },
    { type: 'opening', a: pt(2.9, 2.5), b: pt(3.3, 2.5), width: 0.26 },
    wall([pt(3, 2.33), pt(3.7, 2.33)], 'stone', 0.14),
    wall([pt(3, 2.67), pt(3.7, 2.67)], 'stone', 0.14),
  ]);
}

function flyby() {
  return build({
    name: 'Flyby',
    blurb: 'Open air and one speaker. Open Sources and press Fly past me: the pitch drops as it passes, though nothing in the code changes its pitch.',
    width: 16,
    height: 6,
    airLoss: 0.5,
    edges: 'open',
    ear: { x: 8, y: 3.8, angle: Math.PI / 2 },
    suggestedSource: { x: 2, y: 3 },
    speakers: [{
      id: 'fly', name: 'Speaker 1', x: 2, y: 3, signal: 'tone', frequency: 600, phase: 0, delay: 0, gain: 0.3, on: false,
    }],
  });
}

export const SCENES = Object.freeze([
  { key: 'cathedral', make: cathedral },
  { key: 'whispering-gallery', make: whisperingGallery },
  { key: 'cave', make: cave },
  { key: 'next-door', make: adjoiningRooms },
  { key: 'organ-pipe', make: organPipe },
  { key: 'double-slit', make: doubleSlit },
  { key: 'acoustic-lens', make: acousticLens },
  { key: 'dead-room', make: anechoic },
  { key: 'time-mirror', make: timeMirror },
  { key: 'flutter-corridor', make: corridor },
  { key: 'bottle', make: bottle },
  { key: 'flyby', make: flyby },
]);

export function makeScene(key) {
  const scene = SCENES.find((s) => s.key === key) ?? SCENES[0];
  return { ...scene.make(), sceneKey: scene.key };
}

export { curvePoints };
