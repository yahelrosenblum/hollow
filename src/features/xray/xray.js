// Acoustic X-Ray workspace. Drag the probe anywhere while sound is running.

import { el, metrics } from '../../app/dom.js';
import { doorOpenness, signedDistance } from '../../scene/room.js';
import { roomToScreen } from '../../scene/layout.js';
import { toCell } from '../../scene/rasterise.js';
import { MATERIALS } from '../../sim/materials.js';
import { C_AIR } from '../../sim/numerics.js';
import { Probe, XRAY_TAPS, probeCells } from './probe.js';

const TRACE_SAMPLES_SECONDS = 0.03;
const UI_INTERVAL_MS = 70;

const MATERIAL_INFO = new Map(MATERIALS.map((m) => [m.key, m]));

function describeMaterial(key) {
  const m = MATERIAL_INFO.get(key);
  if (!m) return { name: key, detail: '' };
  if (m.kind === 'wall') return { name: m.label, detail: `absorbs ${Math.round((1 - ((1 - m.beta) / (1 + m.beta)) ** 2) * 100)}% head-on` };
  if (m.kind === 'sheet') return { name: m.label, detail: `${m.surfaceDensity} kg/m² sheet` };
  return { name: m.label, detail: `sound at ${Math.round(C_AIR * m.c)} m/s` };
}

// What the point is inside, and the nearest thing that reflects sound, from the same distance
// function that builds the solver's grid.
export function describePoint(room, point) {
  let inside = null;
  let nearest = null;
  const edges = [
    { d: point.x, name: 'West edge' },
    { d: room.width - point.x, name: 'East edge' },
    { d: point.y, name: 'North edge' },
    { d: room.height - point.y, name: 'South edge' },
  ];
  for (const edge of edges) {
    if (!nearest || edge.d < nearest.distance) {
      nearest = {
        distance: edge.d,
        name: room.edges === 'open' ? `Open ${edge.name.toLowerCase()}` : edge.name,
        material: room.edges === 'open' ? null : room.edgeMaterial ?? 'stone',
      };
    }
  }
  for (const o of room.objects) {
    if (o.type === 'opening') continue;
    const d = signedDistance(o, point);
    if (d <= 0) inside = o;
    if (d > 0 && d < nearest.distance) {
      const open = o.type === 'window' && o.open;
      if (!open) {
        nearest = {
          distance: d,
          name: o.type === 'door' ? `Door (${doorOpenness(o) > 0.5 ? 'open' : 'shut'})` : o.type,
          material: o.type === 'window' ? 'glass' : o.material,
        };
      }
    }
  }
  return { inside, nearest };
}

function nearestSource(room, point, lastClap) {
  let best = null;
  for (const s of room.speakers ?? []) {
    if (s.on) {
      const d = Math.hypot(s.x - point.x, s.y - point.y);
      if (!best || d < best.distance) best = { distance: d, name: s.name ?? 'Speaker' };
    }
  }
  if (lastClap) {
    const d = Math.hypot(lastClap.x - point.x, lastClap.y - point.y);
    if (!best || d < best.distance) best = { distance: d, name: 'Last clap' };
  }
  return best;
}

function formatPressure(value) {
  const a = Math.abs(value);
  if (a === 0) return '0';
  if (a >= 0.01) return value.toFixed(4);
  return value.toExponential(2);
}

function level(value) {
  return value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dB` : 'silent';
}

export function xrayWorkspace(app) {
  const state = {
    point: null,
    probe: null,
    remove: null,
    removeLayer: null,
    lastUi: 0,
    reading: null,
    tapOffset: 2,
  };
  let readout;
  let trace;
  let placeNote;
  let dial;
  let pressureValue;

  const tool = {
    cursor: 'crosshair',
    down(point) {
      if (app.isInside(point)) place(point);
    },
    move(point, _event, dragging) {
      if (dragging && app.isInside(point)) place(point);
    },
    keyboardAct(point) {
      if (app.isInside(point)) place(point);
    },
  };

  function place(point) {
    state.point = point;
    state.probe?.reset();
    const cell = toCell(point, app.size);
    const rounded = { x: Math.round(cell.x), y: Math.round(cell.y) };
    app.sim.send('setTapCells', { cells: probeCells(rounded) });
    updatePlace();
    app.overlay.dirty = true;
  }

  function updatePlace() {
    if (!placeNote || !state.point) return;
    const { inside, nearest } = describePoint(app.room, state.point);
    const source = nearestSource(app.room, state.point, app.lastClap);
    const material = inside
      ? describeMaterial(inside.type === 'window' ? 'glass' : inside.material ?? 'air')
      : describeMaterial('air');
    placeNote.cells.material.textContent = material.name;
    placeNote.cells.materialDetail.textContent = material.detail;
    placeNote.cells.source.textContent = source ? `${source.distance.toFixed(2)} m` : 'none yet';
    placeNote.cells.sourceName.textContent = source ? source.name : '–';
    placeNote.cells.boundary.textContent = `${nearest.distance.toFixed(2)} m`;
    placeNote.cells.boundaryName.textContent = nearest.material
      ? `${nearest.name}, ${describeMaterial(nearest.material).name.toLowerCase()}`
      : nearest.name;
    placeNote.cells.position.textContent = `${state.point.x.toFixed(2)}, ${state.point.y.toFixed(2)} m`;
  }

  function onSamples(message) {
    if (!state.point || message.taps < state.tapOffset + XRAY_TAPS) return;
    if (!state.probe || state.probe.rate !== message.rate) {
      state.probe = new Probe(message.rate, app.size.dx);
    }
    state.probe.push(message.values, message.count, message.taps, state.tapOffset);
    const now = performance.now();
    if (now - state.lastUi >= UI_INTERVAL_MS) {
      state.lastUi = now;
      state.reading = state.probe.read();
      renderReading();
      app.overlay.dirty = true;
    }
  }

  function renderReading() {
    const r = state.reading;
    if (!readout || !r) return;
    const { cells } = readout;
    pressureValue.textContent = formatPressure(r.pressure);
    cells.level.textContent = r.silent ? 'silent' : level(r.rms);
    cells.energy.textContent = r.silent ? '–' : `${(10 * Math.log10(r.energy + 1e-30)).toFixed(1)} dB`;
    if (r.frequency.status === 'measuring') {
      cells.frequency.textContent = 'measuring…';
    } else if (r.frequency.status === 'silent') {
      cells.frequency.textContent = 'no sound';
    } else {
      cells.frequency.textContent = `${r.frequency.hz.toFixed(0)} Hz`;
    }
    cells.resolution.textContent = `± ${r.frequency.binHz.toFixed(1)} Hz`;
    if (r.silent) {
      cells.direction.textContent = 'no sound';
    } else if (r.hasDirection) {
      const compass = ((Math.round((r.direction * 180) / Math.PI) + 360) % 360);
      cells.direction.textContent = `${compass}°`;
    } else {
      cells.direction.textContent = 'no dominant direction';
    }
    cells.confidence.textContent = r.silent ? '–' : `${Math.round(r.confidence * 100)}% travelling`;
    drawTrace();
    drawDial(r);
    app.announce(
      r.silent ? 'Probe: silent' : `Probe: ${level(r.rms)}, ${cells.frequency.textContent}, ${cells.direction.textContent}`,
      { throttled: true },
    );
  }

  function drawTrace() {
    if (!trace || !state.probe) return;
    const ctx = trace.getContext('2d');
    const { width, height } = trace;
    const data = state.probe.recent(Math.round(state.probe.rate * TRACE_SAMPLES_SECONDS));
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(236,230,216,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    let peak = 1e-6;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    ctx.strokeStyle = '#ece6d8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(1, data.length - 1)) * width;
      const y = height / 2 - (v / peak) * (height / 2 - 3);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawDial(r) {
    if (!dial) return;
    const ctx = dial.getContext('2d');
    const { width, height } = dial;
    const c = { x: width / 2, y: height / 2 };
    const radius = Math.min(width, height) / 2 - 4;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(236,230,216,0.3)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    for (let a = 0; a < 8; a += 1) {
      const angle = (a * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(c.x + Math.cos(angle) * (radius - 4), c.y + Math.sin(angle) * (radius - 4));
      ctx.lineTo(c.x + Math.cos(angle) * radius, c.y + Math.sin(angle) * radius);
      ctx.stroke();
    }
    if (r.hasDirection) {
      const length = radius * Math.max(0.25, r.confidence);
      ctx.strokeStyle = '#ece6d8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + Math.cos(r.direction) * length, c.y + Math.sin(r.direction) * length);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.fillStyle = 'rgba(236,230,216,0.45)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawLayer(ctx, view) {
    if (!state.point) return;
    const c = roomToScreen(view, state.point);
    ctx.strokeStyle = '#ece6d8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
    ctx.moveTo(c.x - 17, c.y);
    ctx.lineTo(c.x - 6, c.y);
    ctx.moveTo(c.x + 6, c.y);
    ctx.lineTo(c.x + 17, c.y);
    ctx.moveTo(c.x, c.y - 17);
    ctx.lineTo(c.x, c.y - 6);
    ctx.moveTo(c.x, c.y + 6);
    ctx.lineTo(c.x, c.y + 17);
    ctx.stroke();
    const r = state.reading;
    if (r?.hasDirection) {
      const length = 18 + 28 * r.confidence;
      const end = { x: c.x + Math.cos(r.direction) * length, y: c.y + Math.sin(r.direction) * length };
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(end.x, end.y);
      const wing = 6;
      for (const side of [2.6, -2.6]) {
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x + Math.cos(r.direction + side) * wing, end.y + Math.sin(r.direction + side) * wing);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  function render() {
    readout = metrics([
      { key: 'level', label: 'Level' },
      { key: 'energy', label: 'Energy here' },
      { key: 'frequency', label: 'Strongest frequency' },
      { key: 'resolution', label: 'Frequency resolution' },
      { key: 'direction', label: 'Sound travelling' },
      { key: 'confidence', label: 'How directional' },
    ]);
    placeNote = metrics([
      { key: 'position', label: 'Position' },
      { key: 'material', label: 'You are in' },
      { key: 'materialDetail', label: 'Property' },
      { key: 'source', label: 'To nearest source' },
      { key: 'sourceName', label: 'Which' },
      { key: 'boundary', label: 'To nearest surface' },
      { key: 'boundaryName', label: 'Which' },
    ]);
    trace = el('canvas', { class: 'scope', width: 288, height: 60, 'aria-label': 'Pressure over the last 30 milliseconds' });
    dial = el('canvas', { width: 76, height: 76, 'aria-label': 'Direction the sound energy is travelling' });
    const note = el('p', {
      class: 'note',
      text: 'Levels are relative to the simulation, not sound pressure in the real world. Direction comes from the measured energy flow, so in a reverberant room it often has none, and that is the true answer.',
    });
    pressureValue = el('output', { class: 'instrument-value', text: '–', 'aria-label': 'Pressure now' });
    updatePlace();
    return [
      el('h2', { text: 'Acoustic X-Ray' }),
      el('p', { class: 'placard', text: 'Put the probe anywhere and drag it while sound plays. Everything here is read from the five grid cells under it.' }),
      el(
        'div',
        { class: 'instrument' },
        dial,
        el('div', {}, el('span', { class: 'instrument-label', text: 'Pressure now' }), pressureValue),
      ),
      readout.node,
      trace,
      el('h3', { text: 'This spot' }),
      placeNote.node,
      note,
    ];
  }

  return {
    key: 'xray',
    label: 'Probe',
    render,
    onShow() {
      app.setTool(tool);
      state.remove = app.addSampleListener(onSamples);
      state.removeLayer = app.overlay.addLayer(drawLayer);
      place(state.point ?? { x: app.room.width * 0.35, y: app.room.height * 0.4 });
      app.setHint('');
    },
    onHide() {
      state.remove?.();
      state.removeLayer?.();
      app.sim.send('setTapCells', { cells: [] });
      app.overlay.dirty = true;
    },
    onRoomChange() {
      updatePlace();
    },
    // The tap cells are grid coordinates, so the same spot in the room needs new ones.
    onGridChange() {
      const { room } = app;
      if (!state.point) return;
      place({
        x: Math.min(room.width, state.point.x),
        y: Math.min(room.height, state.point.y),
      });
    },
    // For tests and the challenge code: the live probe.
    get probe() {
      return state.probe;
    },
    get point() {
      return state.point;
    },
    place,
  };
}
