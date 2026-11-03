// The simulation thread. It owns the GPU device, the solver and the field canvas, and talks
// directly to the audio thread. The interface only ever sends it requests.

import { WaveEngine } from './engine.js';
import { RATES, Governor, chooseRate } from './governor.js';
import { ENERGY_TIME_CONSTANT, SimHost, sourceScale } from './host.js';
import { compileGrid, updateGrid } from './compile.js';
import { MIRROR_PULSE_SECONDS, TimeControl } from './time-control.js';
import { bake } from './bake.js';
import { compileOptionsFor, rasterise, toCell } from '../scene/rasterise.js';
import { earPositions } from '../scene/room.js';
import { fitView } from '../scene/layout.js';
import { FieldRenderer } from '../render/field.js';
import {
  BreathSource, BufferSource, ClapSource, NoiseSource, StreamSource, ToneSource,
} from '../audio/sources.js';

const BENCH_MS = 220;
const STATS_INTERVAL_MS = 100;
const SAMPLE_POST_MS = 30;
const MIN_FRAME_MS = 15;
const FRAME_FALLBACK_MS = 40;
const REPLAY_SECONDS = 0.14;
const REPLAY_EXPOSURE = 22;
const STROBE_CYCLES_PER_SECOND = 0.6;
// Per second, so it means the same at every simulation rate. Too much and the reed runs away
// to whichever mode it likes; this much and it settles on the pipe's own fundamental.
export const REED_GAIN_PER_SECOND = 160;
const REED_LEVEL = 0.25;
const EXPOSURE_RELEASE_SECONDS = 1.6;
// Chosen by eye in the paused cathedral, a snap 12 ms after it sounds: the ring bright where it
// meets the columns, and the room behind it dark.
const SLOW_EXPOSURE = 12;
const STOPPED_EXPOSURE = 6;
const CLAP_EXPOSURE = 2.6;
const BREATH_INJECTION = 0.002;

const state = {
  device: null,
  engine: null,
  bakeEngine: null,
  host: null,
  time: null,
  renderer: null,
  governor: null,
  visible: true,
  hiddenDuringMeasure: false,
  measureDoubtful: false,
  measuring: null,
  room: null,
  size: null,
  compiled: null,
  optionsKey: '',
  layout: { width: 1, height: 1, dpr: 1, padding: 16 },
  palette: 'drafting',
  reducedMotion: false,
  viewMode: 'auto',
  replay: null,
  level: 0,
  exposure: 0,
  brightness: 1,
  strobe: null,
  speakers: new Map(),
  voices: new Map(),
  nextVoice: 1,
  samples: { parts: [], count: 0, taps: 0, last: 0 },
  lastStats: 0,
  blowing: false,
  frames: 0,
  frameStamp: 0,
  fps: 0,
  lastDrawn: 0,
  baking: false,
  bakeQueue: Promise.resolve(),
};

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function compileRoom(room, rate) {
  const raster = rasterise(room, rate);
  const options = compileOptionsFor(room, rate, raster.margin);
  const compiled = compileGrid(raster.grid, raster.nx, raster.ny, options);
  return { raster, options, compiled };
}

function optionsKey(rate, raster, options) {
  return JSON.stringify([rate, raster.nx, raster.ny, options]);
}

function applyView() {
  const { room, size, layout, renderer, engine } = state;
  if (!room || !size || !renderer || !engine?.grid) return;
  const view = fitView(room, layout.width, layout.height, layout.padding, layout.inset);
  const pixelsPerCell = view.scale * size.dx * layout.dpr;
  renderer.setView({
    pixelsPerCell,
    originX: view.x * layout.dpr - (0.5 + size.margin) * pixelsPerCell,
    originY: view.y * layout.dpr - (0.5 + size.margin) * pixelsPerCell,
  });
  // The original-versus-reversed wipe splits the room itself, which the controls may not centre.
  state.roomCentreX = (view.x + view.width / 2) * layout.dpr;
}

function placeEars() {
  const { room, size, host } = state;
  const { left, right } = earPositions(room.ear);
  host.setEars(toCell(left, size), toCell(right, size));
}

// Rebuilds everything for a new grid. If only the room's settings changed, at the same rate,
// sound keeps playing from the same places. A different rate or a different room starts
// fresh, and the interface is told, so nothing keeps claiming to play.
function resolveHost(room, rate, { keepVoices = false } = {}) {
  const { raster, options, compiled } = compileRoom(room, rate);
  state.size = { dx: raster.dx, margin: raster.margin, nx: raster.nx, ny: raster.ny };
  state.compiled = compiled;
  state.optionsKey = optionsKey(rate, raster, options);
  state.engine.loadGrid(compiled);
  state.engine.clear();
  state.renderer.bind(state.engine);
  state.room = room;
  state.time.resetForNewGrid();
  state.governor?.settle(performance.now());
  const keep = keepVoices && rate === state.host.rate;
  if (keep) {
    state.host.remapVoices((point) => toCell(point, state.size));
  } else {
    state.host.setRate(rate);
    state.engine.setReed(0, REED_LEVEL);
    state.voices = new Map();
    state.speakers = new Map();
    state.blowing = false;
    post('voices-reset');
  }
  applyView();
  const { left, right } = earPositions(room.ear);
  state.host.ears = { left: toCell(left, state.size), right: toCell(right, state.size) };
  state.replay = null;
  syncSpeakers(room, state.speakers);
}

// Updates the live grid in place, so sound keeps ringing through an edit. A door that closes
// mid-sound really does cut it off.
function setRoom(room) {
  const rate = state.host.rate;
  const raster = rasterise(room, rate);
  const options = compileOptionsFor(room, rate, raster.margin);
  const key = optionsKey(rate, raster, options);
  if (key !== state.optionsKey || !state.compiled) {
    resolveHost(room, rate, { keepVoices: true });
    return;
  }
  const rect = updateGrid(state.compiled, raster.grid);
  if (rect) {
    state.engine.updateRegion(state.compiled, rect);
    state.time.noteRoomChange();
  }
  state.room = room;
  applyView();
  placeEars();
  syncSpeakers(room, state.speakers);
}

function makeSpeakerVoice(speaker) {
  const { rate } = state.host;
  const source = speaker.signal === 'noise'
    ? new NoiseSource(rate, { amplitude: speaker.gain * 0.5, seed: seedFrom(speaker.id) })
    : new ToneSource(rate, {
      frequency: speaker.frequency, amplitude: speaker.gain, phase: speaker.phase, delay: speaker.delay,
    });
  const voice = state.host.addVoice(source, toCell(speaker, state.size));
  voice.point = { x: speaker.x, y: speaker.y };
  return voice;
}

// Each noise speaker needs its own sequence, or two of them would be the same sound.
function seedFrom(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) || 1;
}

// Speakers are data in the room. This keeps the running voices matching that data, retiring a
// voice with a ramp whenever its signal changes.
function syncSpeakers(room, previous) {
  const next = new Map();
  for (const speaker of room.speakers ?? []) {
    const old = previous.get(speaker.id);
    const signature = `${speaker.signal}|${speaker.frequency}|${speaker.phase}|${speaker.delay}|${speaker.gain}`;
    if (!speaker.on) {
      if (old) old.voice.source.stop();
    } else if (old && old.signature === signature && !old.voice.source.done) {
      old.voice.target = toCell(speaker, state.size);
      old.voice.point = { x: speaker.x, y: speaker.y };
      next.set(speaker.id, old);
    } else {
      if (old) old.voice.source.stop();
      next.set(speaker.id, { voice: makeSpeakerVoice(speaker), signature });
    }
  }
  for (const [id, old] of previous) {
    if (!next.has(id) && !old.voice.source.done) old.voice.source.stop();
  }
  state.speakers = next;
  const firstTone = (room.speakers ?? []).find((s) => s.on && s.signal !== 'noise');
  state.strobe = firstTone ? firstTone.frequency : null;
}

async function benchmark(room) {
  const { engine } = state;
  const measurements = [];
  for (const rate of RATES) {
    const { compiled } = compileRoom(room, rate);
    engine.loadGrid(compiled);
    const batch = Math.round(rate / 60);
    const taps = [{ x: 3.5, y: 3.5 }, { x: 5.5, y: 3.5 }];
    const injectors = [{ x: 4.5, y: 4.5 }];
    const samples = new Float32Array(batch);
    await engine.runBatch(batch, { injectors, taps, samples, energyEvery: 8 });
    const started = performance.now();
    let steps = 0;
    while (performance.now() - started < BENCH_MS) {
      await engine.runBatch(batch, { injectors, taps, samples, energyEvery: 8 });
      steps += batch;
    }
    measurements.push({
      rate,
      realtime: steps / ((performance.now() - started) / 1000) / rate,
      cells: compiled.nx * compiled.ny,
    });
  }
  return { measurements, ...chooseRate(measurements) };
}

// A hidden page's GPU work can stall for seconds, so a speed measured during that says nothing
// about this GPU. Such a result is used for now and measured again once the page is back.
async function measure(room) {
  state.hiddenDuringMeasure = !state.visible;
  const measured = await benchmark(room);
  state.measureDoubtful = state.hiddenDuringMeasure;
  return { ...measured, doubtful: state.measureDoubtful };
}

// Only a measurement that worked can lead to another: one that failed is never retried, or a
// broken device would hold every other request in the queue forever.
function remeasure() {
  const run = runRemeasure();
  state.measuring = run.then(
    () => {
      state.measuring = null;
      retryDoubtfulMeasure();
    },
    () => {
      state.measuring = null;
    },
  );
  return run;
}

async function runRemeasure() {
  // The benchmark swaps grids on the solver, so live sound has to stay off it meanwhile.
  const previousRate = state.host.rate;
  state.host.stop();
  state.benchmarking = true;
  let measured;
  try {
    measured = await measure(state.room);
  } catch (error) {
    // Put the room back on the solver: the benchmark left its own grid there.
    state.measureDoubtful = false;
    state.engine.grid = null;
    resolveHost(state.room, previousRate, { keepVoices: true });
    throw error;
  } finally {
    state.benchmarking = false;
    state.host.start();
  }
  state.governor.automatic = true;
  state.governor.setRate(measured.rate, performance.now());
  state.engine.grid = null;
  // Re-read the room: it may have been edited during the measurement. At the same rate,
  // whatever was playing carries on.
  resolveHost(state.room, measured.rate, { keepVoices: measured.rate === previousRate });
  return { rate: measured.rate, measurements: measured.measurements, confident: measured.confident, ...state.size };
}

function retryDoubtfulMeasure() {
  const canRetry = state.visible && state.measureDoubtful && !state.measuring
    && state.governor?.automatic && state.host.mode === 'live' && state.time.kind === 'live';
  if (!canRetry) return;
  remeasure().then(
    (reply) => post('rate-changed', { rate: reply.rate, reason: 'measured' }),
    (error) => post('gpu-error', { message: error.message }),
  );
}

function startReplay() {
  const { rate } = state.host;
  const everySteps = Math.max(1, Math.round(rate * 0.0007));
  // The last frame slot is reserved for the time mirror's reference.
  const frames = Math.min(state.engine.frameCount - 2, Math.ceil((REPLAY_SECONDS * rate) / everySteps));
  state.host.startHistory({ frames, firstFrame: 1, everySteps, stamps: [] });
  state.replay = { frames, playhead: 0 };
}

// `snap` asks for a finger snap rather than a hand clap: the same source, 1.5 ms long instead of
// 12 ms, so it leaves a thin ring rather than a thick band of noise.
function clap(point, { snap = false } = {}) {
  const { host, size, time } = state;
  const centre = toCell(point, size);
  time.noteClap(centre);
  const seed = 1 + Math.floor(Math.random() * 1e6);
  const source = time.isLossless() || snap
    ? new ClapSource(host.rate, 1, seed, MIRROR_PULSE_SECONDS)
    : new ClapSource(host.rate, 1, seed);
  host.addVoice(source, centre);
  if (host.mode === 'live') startReplay();
}

function setBlow(on) {
  state.blowing = on;
  state.engine.setReed(on ? REED_GAIN_PER_SECOND / state.host.rate : 0, REED_LEVEL);
  if (on) {
    // A reed needs something to amplify. A tiny breath of noise is what real ones get too. It
    // lands in the room at the same strength at every rate, the strength the audit uses.
    const voice = state.host.addVoice(
      new BreathSource(state.host.rate, { amplitude: BREATH_INJECTION / sourceScale(state.host.rate) }),
      reedPosition(),
    );
    setTimeout(() => voice.source.stop(), 200);
  }
}

function reedPosition() {
  const reed = state.room.objects.find((o) => o.material === 'reed');
  return toCell(reed ? { x: reed.x + 0.3, y: reed.y } : state.room.ear, state.size);
}

function onBatch(values, count, tapCount, input) {
  // Exposure follows the ears, so the field stays readable from a shout down to a whisper.
  let peak = 0;
  for (let n = 0; n < count; n += 1) {
    peak = Math.max(peak, Math.abs(values[n * tapCount]), Math.abs(values[n * tapCount + 1]));
  }
  if (!Number.isFinite(peak)) {
    recoverFromBlowUp();
    return;
  }
  const fall = Math.exp(-count / (state.host.rate * 0.6));
  state.level = Math.max(peak, state.level * fall);
  // The picture's exposure lets go more slowly than the ears, the way an eye adapts: an echo
  // visibly fades instead of being turned back up to full brightness as it dies away.
  const adapt = Math.exp(-count / (state.host.rate * EXPOSURE_RELEASE_SECONDS));
  state.exposure = Math.max(peak, state.exposure * adapt);
  const buffer = state.samples;
  buffer.parts.push({ values, count, input });
  buffer.count += count;
  buffer.taps = tapCount;
  const now = performance.now();
  if (now - buffer.last >= SAMPLE_POST_MS) flushSamples(now);
  maybeStats(now);
}

// The audit says this should never happen. If a room ever does it anyway, the user gets
// silence and an honest message rather than a burst of noise.
function recoverFromBlowUp() {
  state.engine.clear();
  state.level = 0;
  state.exposure = 0;
  state.samples = { parts: [], count: 0, taps: 0, last: 0 };
  state.host.voices = [];
  post('blow-up', {});
}

function flushSamples(now) {
  const buffer = state.samples;
  if (!buffer.count) return;
  // A tap list can change mid-stream, so only same-shaped batches are joined.
  const parts = buffer.parts.filter((p) => p.values.length === p.count * buffer.taps);
  const count = parts.reduce((sum, p) => sum + p.count, 0);
  const values = new Float32Array(count * buffer.taps);
  const input = new Float32Array(count);
  let at = 0;
  for (const part of parts) {
    values.set(part.values, at * buffer.taps);
    input.set(part.input, at);
    at += part.count;
  }
  post('samples', {
    values, input, count, taps: buffer.taps, rate: state.host.rate, clock: state.host.stepClock,
  }, [values.buffer, input.buffer]);
  buffer.parts = [];
  buffer.count = 0;
  buffer.last = now;
}

function maybeStats(now) {
  if (now - state.lastStats < STATS_INTERVAL_MS) return;
  state.lastStats = now;
  const stats = state.host.stats();
  const lowered = state.host.mode === 'live' ? state.governor.note(stats.underruns, now) : null;
  if (lowered) {
    resolveHost(state.room, lowered);
    state.governor.setRate(lowered, now);
    post('rate-changed', { rate: lowered, reason: 'underruns' });
  }
  post('stats', {
    stats: {
      ...stats, fps: state.fps, automatic: state.governor.automatic, timing: state.engine.timing !== null,
    },
    level: state.level,
  });
  if (state.time.kind !== 'live') state.time.report();
}

function frame() {
  const { host, renderer, engine } = state;
  const now = performance.now();
  // Fast monitors don't need a faster field: that GPU time belongs to the solver. And during a
  // benchmark the solver's buffers are being swapped out, so there's nothing safe to draw.
  if (now - state.lastDrawn < MIN_FRAME_MS || state.benchmarking) {
    scheduleFrame();
    return;
  }
  state.lastDrawn = now;
  state.frames += 1;
  if (now - state.frameStamp >= 500) {
    state.fps = (state.frames * 1000) / (now - state.frameStamp);
    state.frames = 0;
    state.frameStamp = now;
  }
  host.frameTick();
  if (engine.fields) {
    if (host.mode === 'paused' && !host.inFlight && !host.pendingSingleSteps) {
      // With the solver stopped there are no batches to copy from.
      if (!state.pausedCopied || state.pausedStep !== host.stepClock) copyPausedField();
    } else {
      state.pausedCopied = false;
      const pick = state.strobe && !state.replay ? strobePick() : (count) => count;
      host.requestDisplay(pick);
    }
    drawFrame();
  }
  scheduleFrame();
}

function copyPausedField() {
  const { engine, host } = state;
  const encoder = engine.device.createCommandEncoder({ label: 'paused display' });
  // Going backward, the state belonging to this step is the older of the two fields.
  const source = engine.fieldBuffer(host.direction === -1 ? 'prev' : 'cur');
  encoder.copyBufferToBuffer(source, 0, engine.frames, 0, engine.frameBytes);
  engine.device.queue.submit([encoder.finish()]);
  state.pausedCopied = true;
  state.pausedStep = host.stepClock;
}

// A real strobe: copy the field at the moment a tone's phase matches a slowly advancing
// clock. The waves appear to crawl at a walking pace, and each picture is the true field.
function strobePick() {
  const { host } = state;
  const frequency = state.strobe;
  const period = host.rate / frequency;
  const clock = host.stepClock;
  const seconds = performance.now() / 1000;
  return (count) => {
    const phase = ((clock * frequency) / host.rate - seconds * STROBE_CYCLES_PER_SECOND) % 1;
    const wrapped = phase < 0 ? phase + 1 : phase;
    let step = Math.round((1 - wrapped) * period);
    while (step > count) step -= Math.max(1, Math.round(period));
    return Math.max(1, step);
  };
}

function drawFrame() {
  const { renderer, replay, host, time } = state;
  const level = Math.max(state.level, 1e-4);
  const stopped = host.mode !== 'live';
  const mode = state.viewMode;
  let frameIndex = 0;
  let pressureMix = stopped || state.strobe ? 1 : 0.75;
  let energyMix = stopped ? 0.12 : 0.16;
  // Before a wave reaches the ears they've heard nothing, so the exposure is capped by the
  // strength of the sources themselves; otherwise silence would be shown at full brightness.
  let pressureGain = Math.min(1.3 / Math.max(state.exposure, 1e-6), (REPLAY_EXPOSURE * 2) / sourceScale(host.rate));
  let wipeX = -1;
  let wipeFrame = 0;

  const playback = time.playbackFrame();
  const captured = replay
    ? (host.captureSchedule ? host.captureSchedule.captured : replay.frames)
    : 0;
  if (playback !== null) {
    frameIndex = playback;
    pressureMix = 1;
    energyMix = 0;
    pressureGain = REPLAY_EXPOSURE * 2 / sourceScale(host.rate);
  } else if (replay && captured > 0 && mode !== 'energy' && !stopped) {
    // Until the first frame of this clap exists, those slots still hold the previous clap.
    frameIndex = 1 + Math.min(Math.floor(replay.playhead), captured - 1);
    replay.playhead += state.reducedMotion ? 0.35 : 1;
    pressureMix = 1;
    energyMix = 0.2;
    // Exposure comes from the source strength, not the ears, which the wave hasn't reached
    // yet. It opens up as the wave spreads, to offset the 1/sqrt(r) fall-off of a 2D wave.
    const progress = replay.playhead / replay.frames;
    pressureGain = (REPLAY_EXPOSURE * CLAP_EXPOSURE * (1 + progress * 2.5)) / sourceScale(host.rate);
    if (replay.playhead >= replay.frames) state.replay = null;
  } else if (time.kind === 'slow') {
    // Slow motion is still the live field, just slower. The ears lag far behind the waves at
    // this speed, so exposure follows the sources' strength instead.
    pressureMix = 1;
    energyMix = 0.15;
    pressureGain = (REPLAY_EXPOSURE * SLOW_EXPOSURE) / sourceScale(host.rate);
  } else if (stopped) {
    pressureGain = (REPLAY_EXPOSURE * STOPPED_EXPOSURE) / sourceScale(host.rate);
  }

  if (time.compare && playback === null) {
    const match = time.matchingFrame(host.stepClock);
    if (match !== null) {
      wipeX = state.roomCentreX ?? renderer.canvas.width / 2;
      wipeFrame = match;
    }
  }

  if (mode === 'energy') {
    pressureMix = 0.1;
    energyMix = 1;
  } else if (mode === 'pressure') {
    pressureMix = 1;
    energyMix = 0;
  }

  // The energy buffer is a running sum, so it has to be divided by how many samples it holds
  // before it can be compared with the level at the ears.
  const heldSamples = (host.rate * ENERGY_TIME_CONSTANT) / host.energyEvery;
  renderer.setSurface(state.reducedMotion ? 0 : 1);
  renderer.draw({
    frame: frameIndex,
    pressureGain: pressureGain * state.brightness,
    energyGain: (mode === 'energy' ? 1.2 : 0.3) / (level * level * heldSamples + 1e-9),
    energyMix,
    pressureMix,
    wipeX,
    wipeFrame,
  });
}

// Animation frames stop when the window is covered, but slow motion and replays are driven
// from here, so a slow timer takes over rather than leaving time frozen.
function scheduleFrame() {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    frame();
  };
  if (typeof self.requestAnimationFrame === 'function') self.requestAnimationFrame(once);
  setTimeout(once, FRAME_FALLBACK_MS);
}

// Bakes share one solver, so they run strictly one at a time, whoever asks.
function queueBake(request) {
  const run = state.bakeQueue.then(() => runBake(request));
  state.bakeQueue = run.catch(() => {});
  return run;
}

async function runBake({ room, sources, listeners, seconds, rate, frames, downsample }) {
  const useRate = rate ?? state.host.rate;
  if (!state.bakeEngine) state.bakeEngine = await WaveEngine.create(state.device, { headless: true });
  const { compiled, raster } = compileRoom(room, useRate);
  const wasMode = state.host.mode;
  // Live sound holds still during a bake, so the two aren't fighting for the same GPU.
  if (wasMode === 'live') state.host.setMode('paused');
  state.baking = true;
  try {
    const earCells = () => {
      const { left, right } = earPositions(room.ear);
      return [toCell(left, raster), toCell(right, raster)];
    };
    const result = await bake(state.bakeEngine, compiled, {
      sources: sources.map((s) => ({ cell: toCell(s.point, raster), stimulus: s.stimulus })),
      listeners: listeners === 'ears' ? earCells() : listeners.map((p) => toCell(p, raster)),
      steps: Math.round(seconds * useRate),
      frames,
      downsample,
      onProgress: (progress) => post('bake-progress', { progress }),
    });
    return { ...result, size: { dx: raster.dx, margin: raster.margin, nx: raster.nx, ny: raster.ny } };
  } finally {
    state.baking = false;
    if (wasMode === 'live') state.host.setMode('live');
  }
}

const handlers = {
  async init({ canvas, audioPort, room, layout, visible = true, rate = null }) {
    state.visible = visible;
    if (!navigator.gpu) throw new Error('no-webgpu');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no-adapter');
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
      requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
    });
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') post('device-lost', { message: info.message });
    });
    device.addEventListener('uncapturederror', (event) => post('gpu-error', { message: event.error.message }));
    state.device = device;
    state.engine = await WaveEngine.create(device);
    state.layout = layout;
    state.renderer = new FieldRenderer(device, canvas);
    state.renderer.resize(Math.round(layout.width * layout.dpr), Math.round(layout.height * layout.dpr));
    state.host = new SimHost(state.engine, { onBatch });
    state.time = new TimeControl({
      host: state.host,
      engine: state.engine,
      post,
      getRoom: () => state.room,
      getSize: () => state.size,
      getCompiled: () => state.compiled,
    });
    const measured = await measure(room);
    const chosen = rate ?? measured.rate;
    state.governor = new Governor(chosen, { now: performance.now(), automatic: rate === null, observed: state.visible });
    state.host.connectAudio(audioPort);
    state.engine.grid = null;
    resolveHost(room, chosen);
    state.host.start();
    scheduleFrame();
    retryDoubtfulMeasure();
    return {
      rate: chosen,
      measurements: measured.measurements,
      confident: measured.confident,
      doubtful: measured.doubtful,
      timing: state.engine.timing !== null,
    };
  },
  setVisible({ visible }) {
    state.visible = visible;
    if (!visible) state.hiddenDuringMeasure = true;
    state.governor?.setObserved(visible, performance.now());
    if (visible && state.governor) retryDoubtfulMeasure();
  },
  setRoom({ room }) {
    setRoom(room);
    return { ...state.size };
  },
  loadRoom({ room }) {
    state.time.live();
    resolveHost(room, state.host.rate);
    return { ...state.size };
  },
  resize({ layout }) {
    state.layout = layout;
    state.renderer.resize(Math.round(layout.width * layout.dpr), Math.round(layout.height * layout.dpr));
    applyView();
  },
  clap({ point, snap = false }) {
    clap(point, { snap });
  },
  setView({ mode, palette, reducedMotion, brightness }) {
    if (brightness !== undefined) state.brightness = Math.max(0.1, Math.min(10, brightness));
    if (mode !== undefined) state.viewMode = mode;
    if (palette !== undefined) state.renderer.setPalette(palette);
    if (reducedMotion !== undefined) state.reducedMotion = reducedMotion;
  },
  blow({ on }) {
    setBlow(on);
    return { on };
  },
  setRate({ rate }) {
    state.governor.automatic = false;
    state.governor.setRate(rate, performance.now());
    resolveHost(state.room, rate);
    return { rate, ...state.size };
  },
  remeasure,
  clear() {
    state.engine.clear();
    state.level = 0;
    state.exposure = 0;
    state.host.resetTimeline();
    state.time.reference = null;
    state.replay = null;
  },
  addTone({ point, frequency, amplitude = 0.25 }) {
    const id = state.nextVoice;
    state.nextVoice += 1;
    const voice = state.host.addVoice(
      new ToneSource(state.host.rate, { frequency, amplitude }),
      toCell(point, state.size),
    );
    voice.point = point;
    state.voices.set(id, voice);
    state.strobe = frequency;
    return { id };
  },
  stopVoice({ id }) {
    const voice = state.voices.get(id);
    if (voice) {
      voice.source.stop();
      state.voices.delete(id);
    }
    if (![...state.voices.values()].some((v) => v.source instanceof ToneSource)) syncSpeakers(state.room, state.speakers);
  },
  addBuffer({ point, signal, loop }) {
    const id = state.nextVoice;
    state.nextVoice += 1;
    const voice = state.host.addVoice(new BufferSource(signal, { loop }), toCell(point, state.size));
    voice.point = point;
    state.voices.set(id, voice);
    return { id };
  },
  startStream({ point }) {
    const id = state.nextVoice;
    state.nextVoice += 1;
    const voice = state.host.addVoice(new StreamSource(1), toCell(point, state.size));
    voice.point = point;
    state.voices.set(id, voice);
    return { id };
  },
  stream({ id, block }) {
    state.voices.get(id)?.source.push(block);
  },
  moveVoice({ id, point }) {
    const voice = state.voices.get(id);
    if (voice) {
      voice.target = toCell(point, state.size);
      voice.point = point;
    }
  },
  setTapCells({ cells }) {
    state.host.extraTaps = cells;
  },
  stats() {
    return { stats: state.host.stats(), level: state.level, size: state.size };
  },
  bake: queueBake,

  timeLive: () => state.time.live(),
  timePause: () => state.time.pause(),
  timeSlow: ({ divisor }) => state.time.slow(divisor),
  timeStepForward: ({ count }) => state.time.stepForward(count),
  timeStepBack: ({ count }) => state.time.stepBack(count),
  timeRewind: ({ divisor }) => state.time.rewind(divisor),
  timeRecord: () => state.time.recordHistory(),
  timePlayback: ({ speed }) => state.time.startPlayback(speed),
  timeSetPlayback: (payload) => state.time.setPlayback(payload),
  timeCompare({ on }) {
    state.time.compare = on;
    state.time.report();
  },
  async readFieldForTest() {
    const { engine, host } = state;
    await engine.device.queue.onSubmittedWorkDone();
    const cur = await engine.readField(host.direction === -1 ? 'prev' : 'cur');
    return { cur, step: host.stepClock, nx: state.size.nx, ny: state.size.ny };
  },
};

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    // A measurement swaps the solver's buffers around, so everything else waits its turn.
    while (state.measuring && type !== 'setVisible') await state.measuring.catch(() => {});
    const handler = handlers[type];
    if (!handler) throw new Error(`unknown request "${type}"`);
    const result = await handler(payload ?? {});
    if (id !== undefined) post('reply', { id, ok: true, result });
  } catch (error) {
    if (id !== undefined) post('reply', { id, ok: false, error: error.message });
    else post('gpu-error', { message: error.message });
  }
};
