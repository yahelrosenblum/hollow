// Live spectrum and waterfall. Every curve comes from what the ears and sources actually did.

import { button, el, slider } from '../../app/dom.js';
import { SpectrumAnalyser } from './analyser.js';

const MIN_HZ = 30;
const SPEC_HEIGHT = 130;
const FALL_HEIGHT = 110;
const DB_TOP = 0;
const DB_BOTTOM = -90;
const DRAW_MS = 40;

function freqToX(hz, width, maxHz) {
  return (Math.log(hz / MIN_HZ) / Math.log(maxHz / MIN_HZ)) * width;
}

function xToFreq(x, width, maxHz) {
  return MIN_HZ * (maxHz / MIN_HZ) ** (x / width);
}

function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(0)} Hz`;
}

export function spectrumWorkspace(app) {
  const state = {
    analyser: null,
    remove: null,
    frequency: 440,
    level: 0.25,
    voice: null,
    toneRequest: 0,
    lastDraw: 0,
    lastFrames: 0,
    showInput: true,
  };
  let canvas;
  let fall;
  let peakList;
  let resonanceList;
  let toneButton;
  let freqSlider;

  function maxHz() {
    return (state.analyser?.rate ?? app.rate ?? 16000) / 2;
  }

  function excitePoint() {
    const { room } = app;
    return app.lastClap ?? room.suggestedSource ?? { x: room.width * 0.3, y: room.height * 0.45 };
  }

  async function startTone() {
    stopTone();
    app.ensureAudio();
    state.toneRequest += 1;
    const request = state.toneRequest;
    state.voice = 'starting';
    const reply = await app.sim.request('addTone', {
      point: excitePoint(), frequency: state.frequency, amplitude: state.level,
    });
    // Asked to stop, or to change, while this was on its way: this tone is already out of date.
    if (request !== state.toneRequest) {
      app.sim.send('stopVoice', { id: reply.id });
      return;
    }
    state.voice = reply.id;
    toneButton.textContent = 'Stop tone';
    toneButton.setAttribute('aria-pressed', 'true');
  }

  function stopTone() {
    state.toneRequest += 1;
    if (state.voice !== null && state.voice !== 'starting') app.sim.send('stopVoice', { id: state.voice });
    state.voice = null;
    if (toneButton) {
      toneButton.textContent = 'Play test tone';
      toneButton.setAttribute('aria-pressed', 'false');
    }
  }

  function setFrequency(hz, { play = false } = {}) {
    state.frequency = Math.max(MIN_HZ, Math.min(maxHz() * 0.95, hz));
    freqSlider?.set(state.frequency);
    if (play || state.voice !== null) startTone();
  }

  function onSamples(message) {
    if (!state.analyser || state.analyser.rate !== message.rate) {
      state.analyser = new SpectrumAnalyser(message.rate);
    }
    state.analyser.push(message.values, message.count, message.taps, message.input);
    const now = performance.now();
    if (now - state.lastDraw >= DRAW_MS && state.analyser.frames !== state.lastFrames) {
      state.lastDraw = now;
      state.lastFrames = state.analyser.frames;
      draw();
    }
  }

  function dbToY(db, height) {
    return ((DB_TOP - db) / (DB_TOP - DB_BOTTOM)) * height;
  }

  function drawCurve(ctx, db, width, height, colour, { dash = [] } = {}) {
    const { binHz } = state.analyser;
    const top = maxHz();
    ctx.strokeStyle = colour;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let open = false;
    for (let k = 1; k < db.length; k += 1) {
      const hz = k * binHz;
      if (hz >= MIN_HZ) {
        const value = db[k];
        if (Number.isNaN(value)) {
          open = false;
        } else {
          const x = freqToX(hz, width, top);
          const y = dbToY(value, height);
          if (open) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          open = true;
        }
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function draw() {
    if (!canvas) return;
    const { analyser } = state;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const top = maxHz();
    ctx.clearRect(0, 0, width, height);
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.lineWidth = 1;
    for (const hz of [100, 1000, 4000]) {
      if (hz < top) {
        const x = freqToX(hz, width, top);
        ctx.strokeStyle = 'rgba(236,230,216,0.12)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillStyle = 'rgba(236,230,216,0.55)';
        ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, height - 4);
      }
    }
    for (let db = -20; db > DB_BOTTOM; db -= 20) {
      const y = dbToY(db, height);
      ctx.strokeStyle = 'rgba(236,230,216,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    if (state.showInput) {
      drawCurve(ctx, analyser.inputDb, width, height, 'rgba(159,192,138,0.75)', { dash: [2, 3] });
      drawCurve(ctx, analyser.transferDb, width, height, 'rgba(224,127,98,0.85)');
    }
    drawCurve(ctx, analyser.right.db, width, height, 'rgba(236,230,216,0.45)');
    drawCurve(ctx, analyser.left.db, width, height, '#ece6d8');
    const peaks = analyser.peaks();
    ctx.fillStyle = '#ece6d8';
    for (const p of peaks.slice(0, 4)) {
      const x = freqToX(p.hz, width, top);
      const y = dbToY(p.db, height);
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x, y - 3);
      ctx.strokeStyle = '#ece6d8';
      ctx.stroke();
      ctx.fillText(formatHz(p.hz), Math.min(width - 50, x + 2), Math.max(10, y - 9));
    }
    if (state.voice !== null) {
      const x = freqToX(state.frequency, width, top);
      ctx.strokeStyle = '#e9a95c';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    drawFall(analyser, top);
    renderLists(peaks, analyser.resonances());
  }

  function drawFall(analyser, top) {
    const ctx = fall.getContext('2d', { willReadFrequently: false });
    const { width, height } = fall;
    ctx.drawImage(fall, 0, 1);
    const row = ctx.createImageData(width, 1);
    const { binHz } = analyser;
    const db = analyser.left.db;
    for (let x = 0; x < width; x += 1) {
      const hz = xToFreq(x, width, top);
      const bin = Math.min(db.length - 1, Math.max(1, Math.round(hz / binHz)));
      const t = Math.max(0, Math.min(1, (db[bin] - DB_BOTTOM) / (DB_TOP - DB_BOTTOM)));
      const v = t * t;
      const i = x * 4;
      row.data[i] = 8 + 228 * v;
      row.data[i + 1] = 12 + 218 * v;
      row.data[i + 2] = 16 + 200 * v;
      row.data[i + 3] = 255;
    }
    ctx.putImageData(row, 0, 0);
    if (height === 0) ctx.clearRect(0, 0, width, height);
  }

  function peakButton(p, suffix = '') {
    return el(
      'li',
      {},
      el(
        'div',
        { class: 'list-row' },
        el('span', { class: 'name', text: `${formatHz(p.hz)}${suffix}` }),
        el('span', { class: 'note', style: 'margin:0', text: `${p.db.toFixed(0)} dB` }),
        button('Excite', () => setFrequency(p.hz, { play: true })),
      ),
    );
  }

  function renderLists(peaks, resonances) {
    const now = performance.now();
    if (state.lastLists && now - state.lastLists < 500) return;
    state.lastLists = now;
    peakList.replaceChildren(...peaks.slice(0, 4).map((p) => peakButton(p)));
    resonanceList.replaceChildren(...resonances.slice(0, 5).map((p) => peakButton(
      p,
      p.q ? ` · Q ${p.q.toFixed(0)}` : '',
    )));
    if (!resonances.length) {
      resonanceList.replaceChildren(el('li', { class: 'note', text: 'Clap a few times to let the room show its resonances.' }));
    }
  }

  function render() {
    canvas = el('canvas', {
      class: 'scope',
      width: 288,
      height: SPEC_HEIGHT,
      'aria-label': 'Live frequency spectrum at both ears. Click to pick a frequency.',
      onclick: (event) => {
        const rect = event.target.getBoundingClientRect();
        setFrequency(xToFreq(((event.clientX - rect.left) / rect.width) * canvas.width, canvas.width, maxHz()), { play: true });
      },
      style: 'cursor:crosshair',
    });
    fall = el('canvas', {
      class: 'scope',
      width: 288,
      height: FALL_HEIGHT,
      style: 'margin-top:4px',
      'aria-label': 'Waterfall: the left ear spectrum over time, newest at the top',
    });
    peakList = el('ul', { class: 'list' });
    resonanceList = el('ul', { class: 'list' });
    freqSlider = slider({
      label: 'Frequency',
      min: MIN_HZ,
      max: maxHz() * 0.95,
      step: 1,
      value: state.frequency,
      format: (v) => formatHz(v),
      oninput: (v) => setFrequency(v),
    });
    const levelSlider = slider({
      label: 'Tone level',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      value: state.level,
      format: (v) => `${Math.round(v * 100)}%`,
      oninput: (v) => {
        state.level = v;
        if (state.voice !== null) startTone();
      },
    });
    toneButton = button('Play test tone', () => (state.voice === null ? startTone() : stopTone()), { 'aria-pressed': 'false' });
    const compare = el('input', {
      type: 'checkbox',
      checked: state.showInput,
      onchange: (event) => { state.showInput = event.target.checked; },
    });
    return [
      el('h2', { text: 'Spectrum' }),
      el('p', { class: 'placard', text: 'What reaches your ears, measured live. Click anywhere on the graph to send that frequency into the room.' }),
      canvas,
      fall,
      el('p', { class: 'note', html: undefined, text: 'Bright line: left ear. Faint line: right ear. Green dashes: what the sources put in. Red: the room\'s measured response, shown only where the input explains the output.' }),
      el('label', { class: 'note', style: 'display:flex;gap:8px;align-items:center' }, compare, 'Compare input and output'),
      el('h3', { text: 'Test tone' }),
      freqSlider.row,
      levelSlider.row,
      el('div', { class: 'btn-row' }, toneButton),
      el('h3', { text: 'Loudest right now' }),
      peakList,
      el('h3', { text: 'Resonances of this room' }),
      resonanceList,
    ];
  }

  return {
    key: 'spectrum',
    label: 'Spectrum',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
      state.remove = app.addSampleListener(onSamples);
      state.offReset = app.sim.on('voices-reset', () => stopTone());
      renderLists([], []);
    },
    onHide() {
      state.remove?.();
      state.offReset?.();
      stopTone();
    },
    get analyser() {
      return state.analyser;
    },
    get frequency() {
      return state.frequency;
    },
    setFrequency,
  };
}
