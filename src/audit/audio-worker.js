// Worker for the audio path audit: runs the real SimHost against the real worklet and
// measures what happens. It keeps a copy of every ear sample so the sound can be analysed.

import { blankGrid, compileGrid } from '../sim/compile.js';
import { WaveEngine } from '../sim/engine.js';
import { SimHost } from '../sim/host.js';
import { STONE } from '../sim/materials.js';
import { cellSizeFor } from '../sim/numerics.js';
import { ClapSource, ToneSource } from '../audio/sources.js';

const RATE = 16000;
const NX = 485;
const NY = 283;

let host = null;
let captured = [];
let capturing = false;

function roomGrid() {
  const grid = blankGrid(NX, NY, 0);
  for (let y = 0; y < 150; y += 1) {
    for (let x = 200; x < 206; x += 1) grid[y * NX + x] = STONE;
  }
  return compileGrid(grid, NX, NY, { rate: RATE, airSigma: 2 });
}

async function setup(port) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  });
  const engine = await WaveEngine.create(device);
  engine.loadGrid(roomGrid());
  host = new SimHost(engine, {
    onBatch(values) {
      if (capturing) captured.push(values);
    },
  });
  host.setRate(RATE);
  const dx = cellSizeFor(RATE);
  const earCells = 0.18 / dx;
  host.ears = {
    left: { x: 300, y: 140 },
    right: { x: 300 + earCells, y: 140 },
  };
  host.connectAudio(port);
  host.start();
}

// Time from asking for a clap to the audio thread producing it, plus the device's own delay.
function measureLatency() {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timeout = setTimeout(() => reject(new Error('no onset heard')), 3000);
    host.onsetListener = () => {
      clearTimeout(timeout);
      host.onsetListener = null;
      resolve(performance.now() - started);
    };
    host.port.postMessage({ type: 'arm-onset', level: 0.002 });
    // Right beside the ear, so acoustic travel time is under a millisecond.
    host.addVoice(new ClapSource(RATE, 1, 3), { x: 298.5, y: 140.5 });
  });
}

const handlers = {
  async init({ port }) {
    await setup(port);
    return { rate: RATE };
  },
  async latency({ count }) {
    const rows = [];
    for (let n = 0; n < count; n += 1) {
      rows.push(await measureLatency());
      await new Promise((r) => { setTimeout(r, 800); });
    }
    return { rows };
  },
  async tone({ frequency, seconds, amplitude }) {
    captured = [];
    capturing = true;
    const startStats = host.stats();
    const voice = host.addVoice(new ToneSource(RATE, { frequency, amplitude }), { x: 330.5, y: 140.5 });
    await new Promise((r) => { setTimeout(r, seconds * 1000); });
    voice.source.stop();
    capturing = false;
    const total = captured.reduce((sum, part) => sum + part.length, 0);
    const all = new Float32Array(total);
    let at = 0;
    for (const part of captured) {
      all.set(part, at);
      at += part.length;
    }
    const endStats = host.stats();
    return { samples: all, startStats, endStats };
  },
  async stats() {
    return host.stats();
  },
  async soak({ seconds }) {
    const start = host.stats();
    const startedAt = performance.now();
    await new Promise((r) => { setTimeout(r, seconds * 1000); });
    return { start, end: host.stats(), elapsed: (performance.now() - startedAt) / 1000 };
  },
};

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    const result = await handlers[type](payload);
    const transfer = result?.samples ? [result.samples.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};
