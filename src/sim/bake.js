// Runs a room offline on its own solver and measures it. The live simulation is untouched,
// and the same room with the same stimulus gives the same answer, which is what Challenge
// Mode, room comparison and impulse response export all depend on.

import { sourceScale } from './host.js';
import { ClapSource, ImpulseSource, SourceFilter, ToneSource } from '../audio/sources.js';

const BATCH = 1024;
const YIELD_EVERY_MS = 24;

function makeSignal(stimulus, rate) {
  switch (stimulus.kind) {
    case 'impulse':
      return new ImpulseSource(1);
    case 'clap':
      return new ClapSource(rate, 1, stimulus.seed ?? 7);
    case 'tone':
      return new ToneSource(rate, {
        frequency: stimulus.frequency,
        amplitude: stimulus.amplitude ?? 0.25,
        phase: stimulus.phase ?? 0,
        rampSeconds: stimulus.ramp ?? 0.01,
      });
    default:
      throw new RangeError(`unknown stimulus "${stimulus.kind}"`);
  }
}

// sources: [{ cell, stimulus }]. listeners: [cell]. Returns one trace per listener.
// With `frames` set, it also returns evenly spaced downsampled pictures of the field.
export async function bake(engine, compiled, {
  sources, listeners, steps, frames = 0, downsample = 4, onProgress = null, shouldStop = null,
}) {
  engine.loadGrid(compiled);
  engine.clear();
  engine.setReed(0, 1);
  const { rate } = compiled;
  const voices = sources.map((s) => ({
    cell: s.cell, signal: makeSignal(s.stimulus, rate), diff: new SourceFilter(),
  }));
  const scale = sourceScale(rate);
  const traces = listeners.map(() => new Float32Array(steps));
  const scratch = new Float32Array(BATCH);
  const taps = listeners.map((c) => ({ x: c.x, y: c.y, dx: 0, dy: 0 }));
  const injectors = voices.map((v) => ({ x: v.cell.x, y: v.cell.y, dx: 0, dy: 0 }));
  const pictures = [];
  const frameEvery = frames ? Math.max(1, Math.floor(steps / frames)) : 0;
  let nextFrame = frameEvery;
  let done = 0;
  let lastYield = performance.now();

  while (done < steps) {
    let count = Math.min(BATCH, steps - done);
    if (frameEvery) count = Math.min(count, nextFrame - done);
    const samples = new Float32Array(count * voices.length);
    voices.forEach((voice, s) => {
      voice.signal.render(scratch, count, done);
      voice.diff.process(scratch, count);
      for (let n = 0; n < count; n += 1) samples[n * voices.length + s] = scratch[n] * scale;
    });
    let values = await engine.runBatch(count, { injectors, taps, samples });
    while (values === null) {
      await new Promise((r) => { setTimeout(r, 2); });
      values = await engine.runBatch(count, { injectors, taps, samples });
    }
    for (let n = 0; n < count; n += 1) {
      for (let t = 0; t < listeners.length; t += 1) traces[t][done + n] = values[n * listeners.length + t];
    }
    done += count;
    if (frameEvery && done >= nextFrame) {
      pictures.push(shrink(await engine.readField('cur'), compiled, downsample));
      nextFrame += frameEvery;
    }
    const now = performance.now();
    if (now - lastYield > YIELD_EVERY_MS) {
      lastYield = now;
      onProgress?.(done / steps);
      if (shouldStop?.()) return null;
      await new Promise((r) => { setTimeout(r, 0); });
    }
  }
  onProgress?.(1);
  return {
    traces,
    rate,
    pictures,
    pictureWidth: Math.floor(compiled.nx / downsample),
    pictureHeight: Math.floor(compiled.ny / downsample),
  };
}

function shrink(field, { nx, ny }, factor) {
  const w = Math.floor(nx / factor);
  const h = Math.floor(ny / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) out[y * w + x] = field[y * factor * nx + x * factor];
  }
  return out;
}
