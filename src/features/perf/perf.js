// Performance history. WebGPU can't report how busy the GPU is overall, so what's shown is the
// GPU time Hollow's own work took, measured with timestamp queries, against the time available.

import { button, el, metrics, select } from '../../app/dom.js';
import { RATES } from '../../sim/governor.js';
import { downloadBlob } from '../../ui/files.js';

const HISTORY_SECONDS = 180;
const SAMPLE_INTERVAL_MS = 500;

export class PerfHistory {
  constructor(capacity = (HISTORY_SECONDS * 1000) / SAMPLE_INTERVAL_MS) {
    this.capacity = capacity;
    this.samples = [];
    this.events = [];
    this.last = 0;
    this.lastUnderruns = 0;
    this.lastDropped = 0;
    this.lastFrames = 0;
    this.droppedFrames = 0;
  }

  // Dropped frames are counted against the rate the display should be holding.
  note(stats, now) {
    if (now - this.last < SAMPLE_INTERVAL_MS) return null;
    const elapsed = this.last ? now - this.last : SAMPLE_INTERVAL_MS;
    this.last = now;
    const audioMs = stats.lastCount ? (stats.lastCount / stats.rate) * 1000 : 0;
    const sample = {
      t: now,
      rate: stats.rate,
      gpuMs: stats.gpuMs,
      budget: audioMs > 0 && stats.gpuMs ? stats.gpuMs / audioMs : null,
      latencyMs: stats.targetSeconds * 1000,
      underruns: stats.underruns,
      underrunsAdded: Math.max(0, stats.underruns - this.lastUnderruns),
      dropped: stats.dropped,
      fps: stats.fps,
      elapsed,
    };
    this.lastUnderruns = stats.underruns;
    this.samples = [...this.samples.slice(-(this.capacity - 1)), sample];
    return sample;
  }

  noteEvent(text, now) {
    this.events = [...this.events.slice(-50), { t: now, text }];
  }

  export() {
    return { samples: this.samples, events: this.events, note: 'gpuMs is GPU time for Hollow\'s own batches from timestamp queries, not overall GPU utilisation.' };
  }
}

export function perfWorkspace(app) {
  const history = new PerfHistory();
  const state = { rateChoice: 'auto' };
  let chart;
  let readout;
  let timingNote;
  let eventList;

  function onStats({ stats }) {
    const sample = history.note(stats, performance.now());
    if (sample?.underrunsAdded) history.noteEvent(`${sample.underrunsAdded} dropout${sample.underrunsAdded > 1 ? 's' : ''}`, sample.t);
    if (history.lastRate && history.lastRate !== stats.rate) {
      history.noteEvent(`Rate changed to ${stats.rate / 1000} kHz`, performance.now());
    }
    history.lastRate = stats.rate;
    if (sample && chart?.isConnected) draw(sample, stats);
  }

  function drawLine(ctx, values, height, width, colour, maximum) {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = (i / Math.max(1, history.capacity - 1)) * width;
      const y = height - (Math.min(v, maximum) / maximum) * (height - 4) - 2;
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    });
    ctx.stroke();
  }

  function draw(sample, stats) {
    const ctx = chart.getContext('2d');
    const { width, height } = chart;
    ctx.clearRect(0, 0, width, height);
    const budgetLine = height - (1 / 1.5) * (height - 4) - 2;
    ctx.strokeStyle = 'rgba(224,127,98,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, budgetLine);
    ctx.lineTo(width, budgetLine);
    ctx.stroke();
    ctx.setLineDash([]);
    const { samples } = history;
    drawLine(ctx, samples.map((s) => s.budget), height, width, '#ece6d8', 1.5);
    drawLine(ctx, samples.map((s) => s.latencyMs / 200), height, width, '#6fb0d6', 1.5);
    ctx.fillStyle = '#e07f62';
    samples.forEach((s, i) => {
      if (s.underrunsAdded) ctx.fillRect((i / Math.max(1, history.capacity - 1)) * width, 0, 2, height);
    });
    const { cells } = readout;
    cells.rate.textContent = `${stats.rate / 1000} kHz${stats.automatic ? ', automatic' : ', fixed by you'}`;
    cells.gpu.textContent = stats.timing && stats.gpuMs
      ? `${stats.gpuMs.toFixed(1)} ms per batch`
      : 'not available here';
    cells.budget.textContent = sample.budget === null ? 'not available here' : `${Math.round(sample.budget * 100)}% of real time`;
    const device = app.output.outputLatency() * 1000;
    cells.latency.textContent = `${Math.round(sample.latencyMs + device)} ms`;
    cells.fps.textContent = Math.round(stats.fps ?? 0);
    cells.dropouts.textContent = stats.underruns;
    cells.dropped.textContent = stats.dropped;
    timingNote.textContent = stats.timing
      ? 'GPU time is Hollow\'s own work, from timestamp queries. WebGPU cannot report how busy the GPU is overall, so other programs show up only as dropouts and a longer delay.'
      : 'This browser does not provide GPU timestamps, so GPU time is not shown rather than estimated.';
    eventList.replaceChildren(...history.events.slice(-6).reverse().map((event) => el('li', { class: 'note', text: `${Math.round((performance.now() - event.t) / 1000)} s ago: ${event.text}` })));
  }

  function render() {
    chart = el('canvas', {
      class: 'scope',
      width: 288,
      height: 110,
      'aria-label': 'History of GPU budget and audio delay over the last three minutes',
    });
    readout = metrics([
      { key: 'rate', label: 'Simulation rate' },
      { key: 'gpu', label: 'GPU time' },
      { key: 'budget', label: 'GPU budget used' },
      { key: 'latency', label: 'Sound delay' },
      { key: 'fps', label: 'Field frames per second' },
      { key: 'dropouts', label: 'Audio dropouts' },
      { key: 'dropped', label: 'Skipped solver batches' },
    ]);
    timingNote = el('p', { class: 'note' });
    eventList = el('ul', { class: 'list' });
    const rate = select({
      label: 'Rate',
      value: state.rateChoice,
      options: [
        { value: 'auto', label: 'Automatic' },
        ...RATES.map((r) => ({ value: String(r), label: `${r / 1000} kHz (sound up to ${(r * 0.25 / 1000).toFixed(1)} kHz)` })),
      ],
      onchange: async (value) => {
        try {
          const reply = value === 'auto'
            ? await app.sim.request('remeasure')
            : await app.sim.request('setRate', { rate: Number(value) });
          state.rateChoice = value;
          app.rate = reply.rate;
          app.gridChanged(reply);
          if (value === 'auto') app.toast(`Measured your GPU: ${app.rate / 1000} kHz.`);
          history.noteEvent(`Rate set to ${app.rate / 1000} kHz`, performance.now());
        } catch (error) {
          app.toast(`The rate could not be changed: ${error.message}`);
        }
      },
    });
    return [
      el('h2', { text: 'Performance' }),
      el('p', { class: 'placard', text: 'How this machine is coping, over the last three minutes.' }),
      chart,
      el('p', { class: 'note', text: 'White: GPU budget. Blue: buffer delay. Red marks: dropouts. Dashed line: the most the GPU can spend and still keep up.' }),
      readout.node,
      timingNote,
      rate.row,
      el('p', { class: 'note', text: 'Compute grows with the cube of the rate. Hollow steps down by itself when sound starts to drop out, and never steps back up on its own.' }),
      el('h3', { text: 'Events' }),
      eventList,
      el('div', { class: 'btn-row' }, button('Export history', () => {
        downloadBlob(new Blob([JSON.stringify(history.export(), null, 1)], { type: 'application/json' }), 'hollow-performance.json');
      })),
    ];
  }

  app.addStatsListener(onStats);

  return {
    key: 'perf',
    label: 'Perf',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
    },
    history,
  };
}
