// Multi-source experiments. Speakers are ordinary room data, phase-locked to the solver clock,
// so anything they do to each other happens in the wave equation and nowhere else.

import { button, el, select, slider } from '../../app/dom.js';
import { newId, setEar } from '../../scene/room.js';
import { toCell, toMetres } from '../../scene/rasterise.js';
import { LIMITS } from '../../scene/schema.js';

const GRAB_METRES = 0.35;
const DEFAULT_TONE = 500;
const DEFAULT_GAIN = 0.25;
const FLY_SPEED = 25;

function makeSpeaker(point, fields = {}) {
  return {
    id: newId('s'),
    name: 'Speaker',
    x: point.x,
    y: point.y,
    signal: 'tone',
    frequency: DEFAULT_TONE,
    phase: 0,
    delay: 0,
    gain: DEFAULT_GAIN,
    on: true,
    ...fields,
  };
}

function symmetricEar(ear, size) {
  const quarter = Math.PI / 2;
  const cell = toCell(ear, size);
  return {
    ...toMetres({ x: Math.round(cell.x), y: Math.round(cell.y) }, size),
    angle: Math.round(ear.angle / quarter) * quarter,
  };
}

export function renumber(speakers) {
  return speakers.map((s, n) => ({ ...s, name: `Speaker ${n + 1}` }));
}

export function sourcesWorkspace(app) {
  let selectedId = null;
  let body;
  const state = { flying: false };

  function speakers() {
    return app.room.speakers ?? [];
  }

  function setSpeakers(list, options) {
    app.commit({ ...app.room, speakers: list }, options);
  }

  function update(id, changes, group) {
    setSpeakers(speakers().map((s) => (s.id === id ? { ...s, ...changes } : s)), { group });
  }

  function refresh() {
    app.overlay.selectedSpeaker = selectedId;
    if (body) body.replaceChildren(...renderSpeakers());
    app.overlay.dirty = true;
  }

  function add(point) {
    if (speakers().length >= LIMITS.maxSpeakers) {
      app.toast(`Hollow runs up to ${LIMITS.maxSpeakers} speakers at once.`);
      return;
    }
    const speaker = makeSpeaker(point);
    setSpeakers(renumber([...speakers(), speaker]));
    selectedId = speaker.id;
    app.ensureAudio();
    refresh();
    app.announce('Speaker added');
  }

  function remove(id) {
    setSpeakers(renumber(speakers().filter((s) => s.id !== id)));
    if (selectedId === id) selectedId = null;
    refresh();
  }

  function speakerAt(point) {
    let best = null;
    let bestDistance = GRAB_METRES;
    for (const s of speakers()) {
      const d = Math.hypot(s.x - point.x, s.y - point.y);
      if (d < bestDistance) {
        best = s;
        bestDistance = d;
      }
    }
    return best;
  }

  const tool = {
    cursor: 'crosshair',
    wantsHover: true,
    grab: null,
    group: 0,
    down(point) {
      const hit = speakerAt(point);
      this.group += 1;
      if (hit) {
        selectedId = hit.id;
        this.grab = hit.id;
        refresh();
      } else if (app.isInside(point)) {
        add(point);
        this.grab = selectedId;
      }
    },
    move(point, _event, dragging) {
      if (dragging && this.grab && app.isInside(point)) {
        update(this.grab, { x: point.x, y: point.y }, `move-${this.group}`);
      }
    },
    up() {
      this.grab = null;
    },
    keyboardAct(point) {
      const hit = speakerAt(point);
      if (hit) {
        selectedId = hit.id;
        refresh();
      } else if (app.isInside(point)) {
        add(point);
      }
    },
  };

  // An experiment worth starting from: two equal speakers, one ahead of the listener and one
  // behind. Ears sit to either side of the head, so this is the only line along which both
  // ears are equidistant from both speakers, and in-phase adds and anti-phase cancels at each.
  //
  // The head is only a few cells across. Off-centre on the grid, it scatters the two speakers
  // differently, and the null then depended on where you stood: measured anywhere from 4 to
  // 54 dB. So the listener moves to the nearest cell centre and faces along a grid axis, where
  // the two paths are exact mirror images, as a careful experimenter would set it up.
  function setupPair(phase) {
    const { width, height } = app.room;
    const ear = symmetricEar(app.room.ear, app.size);
    const c = Math.round(Math.cos(ear.angle));
    const s = Math.round(Math.sin(ear.angle));
    const reach = (position, direction, size) => {
      if (direction === 0) return Infinity;
      return Math.min((size - position) / Math.abs(direction), position / Math.abs(direction)) - 0.3;
    };
    const { dx } = app.size;
    const d = Math.round(Math.max(0.3, Math.min(1.6, reach(ear.x, c, width), reach(ear.y, s, height))) / dx) * dx;
    const pair = [
      makeSpeaker({ x: ear.x + c * d, y: ear.y + s * d }, { phase: 0 }),
      makeSpeaker({ x: ear.x - c * d, y: ear.y - s * d }, { phase }),
    ];
    app.commit({ ...setEar(app.room, ear), speakers: renumber(pair) });
    selectedId = pair[0].id;
    app.ensureAudio();
    app.viewMode = 'energy';
    app.sim.send('setView', { mode: 'energy' });
    refresh();
  }

  function renderSpeaker(s) {
    const frequency = slider({
      label: 'Frequency',
      min: 40,
      max: Math.round(app.rate * 0.3),
      step: 1,
      value: Math.min(s.frequency, Math.round(app.rate * 0.3)),
      format: (v) => `${v} Hz`,
      oninput: (v) => update(s.id, { frequency: v }, `f-${s.id}`),
    });
    const phase = slider({
      label: 'Phase',
      min: 0,
      max: 360,
      step: 5,
      value: Math.round((s.phase * 180) / Math.PI),
      format: (v) => `${v}°`,
      oninput: (v) => update(s.id, { phase: (v * Math.PI) / 180 }, `p-${s.id}`),
    });
    const delay = slider({
      label: 'Start delay',
      min: 0,
      max: 500,
      step: 1,
      value: Math.round(s.delay * 1000),
      format: (v) => `${v} ms`,
      oninput: (v) => update(s.id, { delay: v / 1000 }, `d-${s.id}`),
    });
    const gain = slider({
      label: 'Level',
      min: 0,
      max: 0.6,
      step: 0.01,
      value: s.gain,
      format: (v) => `${Math.round(v * 100)}%`,
      oninput: (v) => update(s.id, { gain: v }, `g-${s.id}`),
    });
    const x = slider({
      label: 'Across',
      min: 0,
      max: app.room.width,
      step: 0.05,
      value: s.x,
      format: (v) => `${v.toFixed(2)} m`,
      oninput: (v) => update(s.id, { x: v }, `x-${s.id}`),
    });
    const y = slider({
      label: 'Down',
      min: 0,
      max: app.room.height,
      step: 0.05,
      value: s.y,
      format: (v) => `${v.toFixed(2)} m`,
      oninput: (v) => update(s.id, { y: v }, `y-${s.id}`),
    });
    const signal = select({
      label: 'Signal',
      value: s.signal,
      options: [{ value: 'tone', label: 'Tone' }, { value: 'noise', label: 'Noise' }],
      onchange: (value) => {
        update(s.id, { signal: value });
        refresh();
      },
    });
    return [
      signal.row,
      s.signal === 'tone' ? frequency.row : null,
      s.signal === 'tone' ? phase.row : null,
      s.signal === 'tone' ? delay.row : null,
      gain.row,
      x.row,
      y.row,
      el(
        'div',
        { class: 'btn-row' },
        button('Fly past me', () => flyPast(s.id)),
        button('Remove', () => remove(s.id)),
      ),
    ].filter(Boolean);
  }

  // Sends a speaker past the listener at 25 m/s and back to where it was. Nothing bends the
  // pitch: the moving source just pushes its waves closer together ahead of it.
  function flyPast(id) {
    const speaker = speakers().find((s) => s.id === id);
    if (!speaker || state.flying) return;
    const { room } = app;
    const from = { x: speaker.x, y: speaker.y };
    const lane = Math.max(0.4, Math.min(room.height - 0.4, room.ear.y - 0.5));
    const span = [0.3, room.width - 0.3];
    const seconds = (span[1] - span[0]) / FLY_SPEED;
    const started = performance.now();
    state.flying = true;
    app.ensureAudio();
    const tick = () => {
      const t = (performance.now() - started) / 1000 / seconds;
      if (t >= 1) {
        update(id, { x: from.x, y: from.y }, `fly-${started}`);
        state.flying = false;
        return;
      }
      update(id, { x: span[0] + (span[1] - span[0]) * t, y: lane }, `fly-${started}`);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function renderSpeakers() {
    const list = speakers();
    if (!list.length) return [el('p', { class: 'note', text: 'No speakers yet. Tap the field to place one.' })];
    return list.flatMap((s) => [
      el(
        'div',
        { class: 'list-row', style: 'margin-top:12px;padding-top:8px;border-top:1px solid var(--hairline)' },
        button(s.name, () => {
          selectedId = selectedId === s.id ? null : s.id;
          refresh();
        }, { class: 'link-btn', 'aria-expanded': String(selectedId === s.id) }),
        button(s.on ? 'Stop' : 'Start', () => {
          app.ensureAudio();
          update(s.id, { on: !s.on });
          refresh();
        }, { 'aria-pressed': String(s.on) }),
      ),
      ...(selectedId === s.id ? renderSpeaker(s) : []),
    ]);
  }

  function render() {
    body = el('div', {}, ...renderSpeakers());
    const view = select({
      label: 'Show',
      value: app.viewMode,
      options: [
        { value: 'auto', label: 'Waves, strobed' },
        { value: 'energy', label: 'Where sound gathers' },
        { value: 'pressure', label: 'Pressure, live' },
      ],
      onchange: (mode) => {
        app.viewMode = mode;
        app.sim.send('setView', { mode });
      },
    });
    return [
      el('h2', { text: 'Sources' }),
      el('p', { class: 'placard', text: 'Tap the field to place a speaker, then drag it. Every pattern you see comes from waves adding and cancelling; nothing is drawn on top.' }),
      el(
        'div',
        { class: 'btn-row' },
        button('Two in step', () => setupPair(0)),
        button('Two opposed', () => setupPair(Math.PI)),
        button('Stop all', () => {
          setSpeakers(speakers().map((s) => ({ ...s, on: false })));
          refresh();
        }),
      ),
      el('p', { class: 'note', text: 'Opposed speakers are half a cycle apart. One is placed ahead of you and one behind, so both ears are equidistant and you should hear almost nothing. Step sideways or turn your head and the sound comes back.' }),
      view.row,
      body,
    ];
  }

  return {
    key: 'sources',
    label: 'Sources',
    render,
    onShow() {
      app.setTool(tool);
      refresh();
      app.setHint('');
    },
    onHide() {
      app.overlay.selectedSpeaker = null;
      app.overlay.dirty = true;
    },
    onRoomChange() {
      if (selectedId && !speakers().some((s) => s.id === selectedId)) selectedId = null;
    },
    add,
    setupPair,
  };
}
