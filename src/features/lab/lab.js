// Measure and Compare. Runs the room offline on its own solver, then reads the numbers from
// that measured response.

import { button, el, select } from '../../app/dom.js';
import { analyseResponse, throughChain } from './measure.js';
import { validateRoom } from '../../scene/schema.js';

const MEASURE_SECONDS = 2.5;
const LONG_SECONDS = 6;
const CHART_HEIGHT = 140;
const MIN_HZ = 40;
const PICTURES = 36;
const DOWNSAMPLE = 3;

export function sourcePointFor(room) {
  const { ear } = room;
  if (room.suggestedSource) return room.suggestedSource;
  // Far enough from the listener to be a real room response, not a whisper in the ear.
  const across = ear.x > room.width / 2 ? room.width * 0.25 : room.width * 0.75;
  return { x: across, y: Math.min(room.height - 0.5, Math.max(0.5, room.height * 0.42)) };
}

export function formatDecay(decay, seconds) {
  return decay === null ? `longer than ${(seconds * 0.8).toFixed(1)} s` : `${decay.toFixed(2)} s`;
}

// Bakes until the sound has actually died away, up to a limit.
export async function measureRoom(app, room, { onProgress = null, seconds = MEASURE_SECONDS, rate } = {}) {
  const source = sourcePointFor(room);
  let length = seconds;
  for (;;) {
    const off = onProgress ? app.sim.on('bake-progress', (m) => onProgress(m.progress)) : null;
    let result;
    try {
      result = await app.sim.request('bake', {
        room,
        sources: [{ point: source, stimulus: { kind: 'impulse' } }],
        listeners: 'ears',
        seconds: length,
        rate,
      });
    } finally {
      off?.();
    }
    const analysis = analyseResponse(result.traces[0], result.rate);
    if (analysis.decay !== null || length >= LONG_SECONDS) {
      return { analysis, result, seconds: length, source };
    }
    length = LONG_SECONDS;
  }
}

function drawResponse(canvas, curves, usableHz) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px "IBM Plex Mono", monospace';
  let top = -Infinity;
  for (const curve of curves) {
    for (let k = 1; k < curve.values.length; k += 1) {
      const hz = k * curve.binHz;
      if (hz >= MIN_HZ && hz <= usableHz) top = Math.max(top, curve.values[k]);
    }
  }
  const span = 50;
  const x = (hz) => (Math.log(hz / MIN_HZ) / Math.log(usableHz / MIN_HZ)) * width;
  const y = (db) => ((top + 3 - db) / span) * height;
  for (const hz of [100, 1000, 4000]) {
    if (hz < usableHz) {
      ctx.strokeStyle = 'rgba(236,230,216,0.12)';
      ctx.beginPath();
      ctx.moveTo(x(hz), 0);
      ctx.lineTo(x(hz), height);
      ctx.stroke();
      ctx.fillStyle = 'rgba(236,230,216,0.55)';
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x(hz) + 3, height - 4);
    }
  }
  for (const curve of curves) {
    ctx.strokeStyle = curve.colour;
    ctx.beginPath();
    let started = false;
    for (let k = 1; k < curve.values.length; k += 1) {
      const hz = k * curve.binHz;
      if (hz >= MIN_HZ && hz <= usableHz) {
        if (started) ctx.lineTo(x(hz), y(curve.values[k]));
        else ctx.moveTo(x(hz), y(curve.values[k]));
        started = true;
      }
    }
    ctx.stroke();
  }
}

function drawPicture(canvas, picture, width, height, gain) {
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < picture.length; i += 1) {
    const v = picture[i] * gain;
    const shown = v / (1 + Math.abs(v));
    const a = Math.abs(shown);
    const at = i * 4;
    const warm = shown > 0;
    image.data[at] = 11 + a * ((warm ? 233 : 95) - 11);
    image.data[at + 1] = 16 + a * ((warm ? 169 : 159) - 16);
    image.data[at + 2] = 21 + a * ((warm ? 92 : 201) - 21);
    image.data[at + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function labWorkspace(app) {
  const state = {
    measuring: false,
    measured: null,
    compare: null,
    tone: null,
    toneRequest: 0,
    animation: 0,
    audioSource: null,
  };
  let status;
  let chart;
  let results;
  let compareOut;
  let measureButton;
  let versionA;
  let versionB;

  function renderResults() {
    const m = state.measured;
    if (!m) return;
    const { analysis, seconds } = m;
    drawResponse(chart, [{ values: analysis.smooth, binHz: analysis.response.binHz, colour: '#ece6d8' }], analysis.usableHz);
    const decay = analysis.decay;
    results.replaceChildren(
      el('dl', { class: 'metrics' }, [
        el('dt', { text: 'Echo fades in (RT60)' }),
        el('dd', { class: 'big', text: formatDecay(decay, seconds) }),
        el('dt', { text: 'First sound arrives after' }),
        el('dd', { text: analysis.arrival === null ? '–' : `${(analysis.arrival * 1000).toFixed(1)} ms` }),
        el('dt', { text: 'Usable frequency range' }),
        el('dd', { text: `up to ${(analysis.usableHz / 1000).toFixed(1)} kHz` }),
      ].flat()),
      el('h3', { text: 'Room modes' }),
      analysis.modes.length
        ? el('ul', { class: 'list' }, [...analysis.modes].sort((a, b) => a.hz - b.hz).map((mode) => el(
          'li',
          {},
          el(
            'div',
            { class: 'list-row' },
            el('span', { class: 'name', text: `${mode.hz.toFixed(1)} Hz${mode.q ? ` · Q ${mode.q.toFixed(0)}` : ''}` }),
            button('Hear it', () => exciteMode(mode.hz), { 'aria-pressed': String(state.tone?.hz === mode.hz) }),
          ),
        )))
        : el('p', { class: 'note', text: 'No clear modes: this room absorbs too much for any resonance to stand out.' }),
    );
  }

  // The button is a toggle: pressing the mode that's playing stops it.
  async function exciteMode(hz) {
    const playing = state.tone?.hz === hz;
    stopTone();
    if (playing) {
      renderResults();
      return;
    }
    state.toneRequest += 1;
    const request = state.toneRequest;
    const reply = await app.sim.request('addTone', {
      point: sourcePointFor(app.room), frequency: hz, amplitude: 0.2,
    });
    if (request !== state.toneRequest) {
      app.sim.send('stopVoice', { id: reply.id });
      return;
    }
    state.tone = { id: reply.id, hz };
    app.ensureAudio();
    app.viewMode = 'energy';
    app.sim.send('setView', { mode: 'energy' });
    renderResults();
    app.toast(`Exciting ${hz.toFixed(1)} Hz. The pattern on the field is that mode.`);
  }

  function stopTone() {
    state.toneRequest += 1;
    if (state.tone) app.sim.send('stopVoice', { id: state.tone.id });
    state.tone = null;
  }

  async function measure() {
    if (state.measuring) return;
    state.measuring = true;
    measureButton.disabled = true;
    await stopTone();
    status.textContent = 'Measuring…';
    try {
      state.measured = await measureRoom(app, app.room, {
        onProgress: (p) => { status.textContent = `Measuring… ${Math.round(p * 100)}%`; },
      });
      status.textContent = `Measured at ${(state.measured.result.rate / 1000).toFixed(0)} kHz. Only the 2D room is measured, not a real space.`;
      renderResults();
      app.announce('Measurement finished');
    } catch (error) {
      status.textContent = `The measurement failed: ${error.message}`;
    } finally {
      state.measuring = false;
      measureButton.disabled = false;
    }
  }

  async function bakeVersion(room, seconds) {
    const source = sourcePointFor(room);
    const impulse = await app.sim.request('bake', {
      room,
      sources: [{ point: source, stimulus: { kind: 'impulse' } }],
      listeners: 'ears',
      seconds,
    });
    const clap = await app.sim.request('bake', {
      room,
      sources: [{ point: source, stimulus: { kind: 'clap' } }],
      listeners: 'ears',
      seconds: Math.min(seconds, 0.4),
      frames: PICTURES,
      downsample: DOWNSAMPLE,
    });
    const audio = await app.sim.request('bake', {
      room,
      sources: [{ point: source, stimulus: { kind: 'clap' } }],
      listeners: 'ears',
      seconds,
    });
    return {
      analysis: analyseResponse(impulse.traces[0], impulse.rate),
      pictures: clap.pictures,
      width: clap.pictureWidth,
      height: clap.pictureHeight,
      audio,
    };
  }

  async function versionRooms() {
    const options = [{ value: 'current', label: 'This room, as it is now', room: app.room }];
    const saved = await app.storage.all('rooms').catch(() => []);
    for (const entry of saved) options.push({ value: `saved:${entry.id}`, label: `Saved: ${entry.name}`, room: entry.room });
    const versions = await app.autosave.versions(10).catch(() => []);
    versions.forEach((entry, n) => {
      options.push({ value: `v:${entry.seq}`, label: `Autosave ${n + 1}: ${entry.room?.name ?? ''}`, room: entry.room });
    });
    return options;
  }

  function animatePictures(canvasA, canvasB, a, b) {
    cancelAnimationFrame(state.animation);
    let frame = 0;
    let wait = 0;
    const peak = (pictures) => pictures.reduce((m, p) => {
      let local = m;
      for (let i = 0; i < p.length; i += 8) local = Math.max(local, Math.abs(p[i]));
      return local;
    }, 1e-6);
    const gain = 8 / Math.max(peak(a.pictures), peak(b.pictures));
    const tick = () => {
      if (!canvasA.isConnected) return;
      wait += 1;
      if (wait >= 4) {
        wait = 0;
        drawPicture(canvasA, a.pictures[frame], a.width, a.height, gain);
        drawPicture(canvasB, b.pictures[frame], b.width, b.height, gain);
        frame = (frame + 1) % Math.min(a.pictures.length, b.pictures.length);
      }
      state.animation = requestAnimationFrame(tick);
    };
    tick();
  }

  function playClap(version) {
    state.audioSource?.stop();
    const { context } = app.output;
    const { traces, rate } = version.audio;
    const buffer = context.createBuffer(2, traces[0].length, rate);
    const left = throughChain(traces[0], rate);
    const right = throughChain(traces[1], rate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = app.volume;
    source.connect(gain).connect(context.destination);
    app.ensureAudio();
    source.start();
    state.audioSource = source;
  }

  async function runCompare() {
    const options = await versionRooms();
    const roomA = options.find((o) => o.value === versionA.input.value) ?? options[0];
    const roomB = options.find((o) => o.value === versionB.input.value) ?? options[0];
    const checkedA = validateRoom(roomA.room);
    const checkedB = validateRoom(roomB.room);
    if (!checkedA.ok || !checkedB.ok) {
      app.toast('One of those versions could not be read.');
      return;
    }
    compareOut.replaceChildren(el('p', { class: 'note', text: 'Running both rooms through the same test…' }));
    const a = await bakeVersion(checkedA.room, MEASURE_SECONDS);
    const b = await bakeVersion(checkedB.room, MEASURE_SECONDS);
    state.compare = { a, b };
    renderCompare(a, b);
  }

  function difference(a, b) {
    const count = Math.min(a.analysis.smooth.length, b.analysis.smooth.length);
    const { binHz } = a.analysis.response;
    let sum = 0;
    let n = 0;
    for (let k = 1; k < count; k += 1) {
      const hz = k * binHz;
      if (hz >= MIN_HZ && hz <= a.analysis.usableHz) {
        sum += Math.abs(a.analysis.smooth[k] - b.analysis.smooth[k]);
        n += 1;
      }
    }
    return n ? sum / n : 0;
  }

  function renderCompare(a, b) {
    const canvasA = el('canvas', { width: a.width, height: a.height, style: 'width:100%;display:block;border:1px solid var(--hairline)', 'aria-label': 'Version A field, replayed' });
    const canvasB = el('canvas', { width: b.width, height: b.height, style: 'width:100%;display:block;border:1px solid var(--hairline)', 'aria-label': 'Version B field, replayed' });
    const curves = el('canvas', { class: 'scope', width: 288, height: CHART_HEIGHT, 'aria-label': 'Frequency responses of both versions' });
    drawResponse(curves, [
      { values: a.analysis.smooth, binHz: a.analysis.response.binHz, colour: '#e9a95c' },
      { values: b.analysis.smooth, binHz: b.analysis.response.binHz, colour: '#6fb0d6' },
    ], a.analysis.usableHz);
    const delta = difference(a, b);
    const decayRow = (label, value) => [el('dt', { text: label }), el('dd', { text: value })];
    compareOut.replaceChildren(
      el(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0' },
        el('div', {}, canvasA, el('span', { class: 'note', text: 'A' })),
        el('div', {}, canvasB, el('span', { class: 'note', text: 'B' })),
      ),
      el('div', { class: 'btn-row' }, button('Hear A', () => playClap(a)), button('Hear B', () => playClap(b))),
      curves,
      el('p', { class: 'note', text: 'Orange: A. Blue: B. Both from the same source and listener test.' }),
      el('dl', { class: 'metrics' }, [
        decayRow('Echo fades, A', formatDecay(a.analysis.decay, MEASURE_SECONDS)),
        decayRow('Echo fades, B', formatDecay(b.analysis.decay, MEASURE_SECONDS)),
        decayRow('Lowest mode, A', a.analysis.modes.length ? `${Math.min(...a.analysis.modes.map((m) => m.hz)).toFixed(1)} Hz` : '–'),
        decayRow('Lowest mode, B', b.analysis.modes.length ? `${Math.min(...b.analysis.modes.map((m) => m.hz)).toFixed(1)} Hz` : '–'),
        decayRow('Average response difference', `${delta.toFixed(2)} dB`),
      ].flat()),
    );
    state.lastDifference = delta;
    animatePictures(canvasA, canvasB, a, b);
  }

  function renderVersionPickers(host) {
    versionRooms().then((options) => {
      const list = options.map(({ value, label }) => ({ value, label }));
      versionA = select({ label: 'Version A', value: 'current', options: list, onchange: () => {} });
      versionB = select({ label: 'Version B', value: list[1]?.value ?? 'current', options: list, onchange: () => {} });
      host.replaceChildren(versionA.row, versionB.row);
    });
  }

  function render() {
    status = el('p', { class: 'note', text: 'Sends one click through this room on a separate solver, and listens at your ears.' });
    chart = el('canvas', {
      class: 'scope',
      width: 288,
      height: CHART_HEIGHT,
      'aria-label': 'Measured frequency response of this room',
    });
    results = el('div', {});
    measureButton = button('Measure this room', measure, { class: 'btn wide primary' });
    compareOut = el('div', {});
    const pickers = el('div', {});
    renderVersionPickers(pickers);
    renderResults();
    return [
      el('h2', { text: 'Measure' }),
      el('p', { class: 'placard', text: 'What this room does to sound, in numbers you can check by ear.' }),
      measureButton,
      status,
      chart,
      results,
      el('h3', { text: 'Compare two versions' }),
      el('p', { class: 'note', text: 'Save a room or just keep editing: earlier versions are autosaved. Both get the same test, one after the other.' }),
      pickers,
      el('div', { class: 'btn-row' }, button('Compare', () => runCompare().catch((error) => app.toast(error.message)))),
      compareOut,
    ];
  }

  return {
    key: 'lab',
    label: 'Measure',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
      state.offReset = app.sim.on('voices-reset', () => {
        stopTone();
        renderResults();
      });
    },
    onHide() {
      state.offReset?.();
      cancelAnimationFrame(state.animation);
      stopTone();
      state.audioSource?.stop();
    },
    measure,
    runCompare,
    get measured() {
      return state.measured;
    },
    get lastDifference() {
      return state.lastDifference;
    },
  };
}
