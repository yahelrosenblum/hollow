// The first thing anyone sees. Tapping is clapping; everything else here is optional.

import { button, el, select, slider } from '../../app/dom.js';
import { roomToScreen } from '../../scene/layout.js';
import { setEar } from '../../scene/room.js';
import { PALETTES } from '../../render/palettes.js';

const GRAB_METRES = 0.45;
const TURN_PIXELS = 18;

export class ListenTool {
  constructor(app) {
    this.app = app;
    this.grab = null;
  }

  down(point) {
    const { app } = this;
    const { ear } = app.room;
    const distance = Math.hypot(point.x - ear.x, point.y - ear.y);
    const screenDistance = distance * app.view.scale;
    if (screenDistance < TURN_PIXELS + 8 && distance < GRAB_METRES) {
      this.grab = { kind: 'ear', moved: false };
      return;
    }
    if (!app.isInside(point)) return;
    this.clapAt(point);
  }

  clapAt(point) {
    const { app } = this;
    app.overlay.mark(point);
    app.lastClap = point;
    app.onClap?.(point);
    app.sim.send('clap', { point });
    app.setHint('');
    app.onFirstClap?.();
    app.announce('Clap');
  }

  move(point, _event, dragging) {
    if (!dragging || !this.grab) return;
    const { app } = this;
    const { ear } = app.room;
    if (this.grab.kind === 'ear' && app.isInside(point)) {
      this.grab.moved = true;
      const heading = Math.hypot(point.x - ear.x, point.y - ear.y) > 0.02
        ? Math.atan2(point.y - ear.y, point.x - ear.x)
        : ear.angle;
      app.commit(setEar(app.room, { x: point.x, y: point.y, angle: heading }), { group: 'ear' });
    }
  }

  up() {
    this.grab = null;
  }

  keyboardAct(point) {
    this.clapAt(point);
  }
}

export function listenWorkspace(app, { openScenes, showFiles }) {
  const tool = new ListenTool(app);
  let earX;
  let earY;

  const volume = slider({
    label: 'Volume',
    min: 0,
    max: 1,
    step: 0.01,
    value: app.volume,
    format: (v) => `${Math.round(v * 100)}%`,
    oninput: (v) => app.setVolume(v),
  });

  function render() {
    const { room } = app;
    earX = slider({
      label: 'You, across',
      min: 0.2,
      max: room.width - 0.2,
      step: 0.1,
      value: room.ear.x,
      format: (v) => `${v.toFixed(1)} m`,
      oninput: (v) => app.commit(setEar(app.room, { x: v }), { group: 'ear' }),
    });
    earY = slider({
      label: 'You, down',
      min: 0.2,
      max: room.height - 0.2,
      step: 0.1,
      value: room.ear.y,
      format: (v) => `${v.toFixed(1)} m`,
      oninput: (v) => app.commit(setEar(app.room, { y: v }), { group: 'ear' }),
    });
    const turn = slider({
      label: 'You, facing',
      min: -180,
      max: 180,
      step: 1,
      value: Math.round((room.ear.angle * 180) / Math.PI),
      format: (v) => `${v}°`,
      oninput: (v) => app.commit(setEar(app.room, { angle: (v * Math.PI) / 180 }), { group: 'ear' }),
    });

    const view = select({
      label: 'Show',
      value: app.viewMode,
      options: [
        { value: 'auto', label: 'Waves after a clap' },
        { value: 'energy', label: 'Where sound gathers' },
        { value: 'pressure', label: 'Pressure, live' },
      ],
      onchange: (mode) => {
        app.viewMode = mode;
        app.sim.send('setView', { mode });
      },
    });

    const brightness = slider({
      label: 'Brightness',
      min: 0.25,
      max: 4,
      step: 0.05,
      value: app.brightness,
      format: (v) => `${Math.round(v * 100)}%`,
      oninput: (v) => app.setBrightness(v),
    });

    const palette = select({
      label: 'Colours',
      value: app.palette,
      options: Object.values(PALETTES).map((p) => ({ value: p.key, label: p.label })),
      onchange: (key) => app.setPalette(key),
    });

    const blow = room.objects.some((o) => o.material === 'reed')
      ? button('Hold to blow', null, {
        class: 'btn wide primary',
        onpointerdown: () => {
          app.ensureAudio();
          app.sim.request('blow', { on: true });
        },
        onpointerup: () => app.sim.request('blow', { on: false }),
        onpointerleave: () => app.sim.request('blow', { on: false }),
        onkeydown: (event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            app.ensureAudio();
            app.sim.request('blow', { on: true });
          }
        },
        onkeyup: () => app.sim.request('blow', { on: false }),
      })
      : null;

    return [
      el('h2', { text: room.name }),
      el('p', { class: 'placard', text: room.blurb ?? 'A room of your own. Tap anywhere to clap, then drag yourself around to hear what changes.' }),
      blow,
      el('div', { class: 'btn-row' }, button('Other rooms', openScenes), button('Save or share', showFiles)),
      volume.row,
      el('h3', { text: 'You' }),
      el('p', { class: 'note', text: 'Drag the circle on the field, or use these.' }),
      earX.row,
      earY.row,
      turn.row,
      el('h3', { text: 'View' }),
      view.row,
      brightness.row,
      palette.row,
    ];
  }

  return {
    key: 'listen',
    label: 'Listen',
    render,
    onShow: () => app.setTool(tool),
    onRoomChange(room) {
      earX?.set(room.ear.x);
      earY?.set(room.ear.y);
    },
    tool,
  };
}

export { roomToScreen };
