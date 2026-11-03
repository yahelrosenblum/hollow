// Records what the ears received and what the sources emitted, in chunks to local storage as
// it goes, so a crash mid-take loses at most the last chunk. The take is the raw simulation;
// the disclosed output chain is applied when it's played or exported.

import { newId } from '../../scene/room.js';

export const CHUNK_SECONDS = 1;

export class Recorder {
  constructor(storage) {
    this.storage = storage;
    this.active = null;
  }

  get recording() {
    return this.active !== null;
  }

  async start(room, rate, name) {
    const id = newId('rec');
    const meta = {
      id,
      name,
      rate,
      room,
      createdAt: Date.now(),
      frames: 0,
      chunks: 0,
      open: true,
    };
    await this.storage.put('recordings', meta);
    this.active = {
      meta,
      left: [],
      right: [],
      input: [],
      buffered: 0,
      writing: Promise.resolve(),
    };
    return id;
  }

  // Samples from the simulation thread. A rate change would make a take unplayable, so it
  // ends the take instead.
  push(message) {
    const { active } = this;
    if (!active) return false;
    if (message.rate !== active.meta.rate) return true;
    const { values, count, taps, input } = message;
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    for (let n = 0; n < count; n += 1) {
      left[n] = values[n * taps];
      right[n] = values[n * taps + 1];
    }
    active.left.push(left);
    active.right.push(right);
    active.input.push(input.slice());
    active.buffered += count;
    if (active.buffered >= active.meta.rate * CHUNK_SECONDS) this.flush();
    return false;
  }

  flush() {
    const { active } = this;
    if (!active || !active.buffered) return active?.writing ?? Promise.resolve();
    const join = (parts, total) => {
      const out = new Float32Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    const total = active.buffered;
    const chunk = {
      recording: active.meta.id,
      index: active.meta.chunks,
      left: join(active.left, total),
      right: join(active.right, total),
      input: join(active.input, total),
    };
    active.left = [];
    active.right = [];
    active.input = [];
    active.buffered = 0;
    active.meta = { ...active.meta, frames: active.meta.frames + total, chunks: active.meta.chunks + 1 };
    const { meta } = active;
    active.writing = active.writing
      .then(() => this.storage.put('chunks', chunk))
      .then(() => this.storage.put('recordings', meta));
    return active.writing;
  }

  async stop() {
    const { active } = this;
    if (!active) return null;
    this.flush();
    await active.writing;
    const meta = { ...active.meta, open: false };
    await this.storage.put('recordings', meta);
    this.active = null;
    return meta;
  }

  // Newest first. A take still marked open was cut off by a crash; everything that reached
  // storage is still there, and the listing says so.
  async list() {
    const all = await this.storage.all('recordings');
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async load(meta) {
    const size = meta.frames;
    const left = new Float32Array(size);
    const right = new Float32Array(size);
    const input = new Float32Array(size);
    let at = 0;
    for (let index = 0; index < meta.chunks; index += 1) {
      const chunk = await this.storage.get('chunks', [meta.id, index]);
      if (chunk) {
        left.set(chunk.left, at);
        right.set(chunk.right, at);
        input.set(chunk.input, at);
        at += chunk.left.length;
      }
    }
    return { left, right, input, frames: at };
  }

  async remove(meta) {
    for (let index = 0; index < meta.chunks; index += 1) {
      await this.storage.delete('chunks', [meta.id, index]);
    }
    await this.storage.delete('recordings', meta.id);
  }
}

// The same loudness for two takes, so an A/B isn't won by whichever is louder.
export function matchedGains(a, b, ceiling = 0.8) {
  const rmsOf = (signal) => {
    let sum = 0;
    for (let i = 0; i < signal.length; i += 1) sum += signal[i] * signal[i];
    return Math.sqrt(sum / Math.max(1, signal.length));
  };
  const peakOf = (signal) => signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const ra = rmsOf(a);
  const rb = rmsOf(b);
  if (ra === 0 || rb === 0) return { a: 1, b: 1 };
  const target = Math.min(ra, rb);
  let ga = target / ra;
  let gb = target / rb;
  const worst = Math.max(peakOf(a) * ga, peakOf(b) * gb);
  if (worst > ceiling) {
    ga *= ceiling / worst;
    gb *= ceiling / worst;
  }
  return { a: ga, b: gb };
}
