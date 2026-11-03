// Drives the solver. In live mode the audio thread's consumption report is the clock: this
// loop only ever computes as many steps as are needed to keep the audio buffer at target.
// In dilated and paused modes the display or the user is the clock, and no audio is produced.

import { SourceFilter } from '../audio/sources.js';
import { RESAMPLER_TAPS } from '../audio/resampler.js';
import { SourceLog } from './timeline.js';
import { MAX_BATCH_STEPS } from './engine.js';

const TICK_MS = 4;
// The audio thread starts playing at this fraction of the target, so the target must always
// be reachable beyond it, on top of the samples the resampler holds in reserve.
const PRIME_FRACTION = 0.75;
const MIN_BATCH_SECONDS = 0.008;
// Leaves room to catch up after a stall. It's only ever reached when falling behind.
const MAX_BATCH_SECONDS = 0.12;
const START_TARGET_SECONDS = 0.04;
const MAX_TARGET_SECONDS = 0.2;
const TARGET_GROW_SECONDS = 0.015;
const TARGET_SHRINK_SECONDS = 0.005;
const TARGET_CALM_SECONDS = 20;
const MAX_IN_FLIGHT = 4;
const MAX_INJECTORS = 16;
const SOURCE_SCALE = 20;
const SCALE_REFERENCE_RATE = 16000;
const ENERGY_EVERY_SECONDS = 0.0005;
export const ENERGY_TIME_CONSTANT = 0.3;
const CHECKPOINT_SECONDS = 0.5;
// In cells per step: half the speed of sound, which is lambda cells per step.
const MAX_SOURCE_SPEED = 0.43;

export function maxLiveBatch(rate) {
  return Math.min(MAX_BATCH_STEPS, Math.ceil(MAX_BATCH_SECONDS * rate));
}

// Injected value per unit of source signal. Far-field level goes as dt at a fixed lambda, so
// scaling with the rate keeps loudness the same at every simulation rate.
export function sourceScale(rate) {
  return (SOURCE_SCALE * rate) / SCALE_REFERENCE_RATE;
}

export class SimHost {
  constructor(engine, { onBatch = null } = {}) {
    this.engine = engine;
    this.onBatch = onBatch;
    this.port = null;
    this.running = false;
    this.rate = 16000;
    this.mode = 'live';
    this.direction = 1;
    this.ears = { left: { x: 10, y: 10 }, right: { x: 12, y: 10 } };
    this.earsTarget = null;
    this.extraTaps = [];
    this.voices = [];
    this.log = new SourceLog();
    this.loggingEnabled = true;
    this.produced = 0;
    this.consumed = 0;
    this.scheduled = 0;
    this.stepClock = 0;
    this.inFlight = 0;
    this.dropped = 0;
    this.underruns = 0;
    this.targetSeconds = START_TARGET_SECONDS;
    this.calmSince = 0;
    this.limiterReduction = 0;
    this.outputPeak = 0;
    this.scratch = new Float32Array(MAX_BATCH_STEPS);
    this.inputScratch = new Float32Array(MAX_BATCH_STEPS);
    this.onsetListener = null;
    this.batchMs = 0;
    this.gpuMs = 0;
    this.lastCount = 0;
    this.errors = 0;
    this.captureNext = null;
    this.captureSchedule = null;
    this.energyEvery = 8;
    this.dilatedStepsPerFrame = 0;
    this.dilatedRemainder = 0;
    this.pendingSingleSteps = 0;
    this.stopAtStep = null;
    this.onStop = null;
    this.checkpoints = [];
    this.checkpointEvery = 8000;
    this.nextCheckpoint = 0;
    this.resimulating = null;
  }

  connectAudio(port) {
    this.port = port;
    port.onmessage = (event) => this.onAudioMessage(event.data);
    this.configureAudio();
  }

  configureAudio() {
    if (!this.port) return;
    this.audioSession = (this.audioSession ?? 0) + 1;
    this.port.postMessage({
      type: 'configure', rate: this.rate, primeSeconds: this.targetSeconds * PRIME_FRACTION,
    });
    this.produced = 0;
    this.consumed = 0;
    this.scheduled = 0;
  }

  setRate(rate) {
    this.rate = rate;
    this.energyEvery = Math.max(1, Math.round(rate * ENERGY_EVERY_SECONDS));
    this.engine.setEnergyDecay(Math.exp(-this.energyEvery / (rate * ENERGY_TIME_CONSTANT)));
    this.voices = [];
    this.extraTaps = [];
    this.checkpointEvery = Math.round(rate * CHECKPOINT_SECONDS);
    this.resetTimeline();
    this.configureAudio();
  }

  // The same rate on a new grid: sound carries on, from the same places in the room.
  remapVoices(toCell) {
    for (const voice of this.voices) {
      if (voice.point) {
        const cell = toCell(voice.point);
        voice.x = cell.x;
        voice.y = cell.y;
        voice.target = null;
      }
    }
    this.extraTaps = [];
    this.resetTimeline();
  }

  // Forgets recorded time. After this, the present is the earliest moment there is.
  resetTimeline() {
    this.log.clear();
    this.checkpoints = [];
    this.stepClock = 0;
    this.nextCheckpoint = 0;
    this.direction = 1;
    this.engine.reversed = false;
  }

  // Old checkpoints describe a room that no longer exists, so they can't be replayed.
  invalidateCheckpoints() {
    this.checkpoints = [];
    this.nextCheckpoint = this.stepClock;
  }

  onAudioMessage(message) {
    switch (message.type) {
      case 'clock':
        this.consumed = message.consumed;
        this.limiterReduction = message.reduction;
        this.outputPeak = Math.max(this.outputPeak * 0.98, message.peak);
        if (message.underruns !== this.underruns) this.noteUnderrun(message.underruns);
        break;
      case 'onset':
        if (this.onsetListener) this.onsetListener(message);
        break;
      default:
        break;
    }
  }

  // An underrun means the buffer was too small for this machine right now, so buffer more.
  // After a long quiet spell it creeps back down, to get latency back.
  noteUnderrun(total) {
    this.underruns = total;
    this.targetSeconds = Math.min(MAX_TARGET_SECONDS, this.targetSeconds + TARGET_GROW_SECONDS);
    this.calmSince = performance.now();
    this.port?.postMessage({ type: 'prime', seconds: this.targetSeconds * PRIME_FRACTION });
  }

  relaxTarget() {
    const now = performance.now();
    if (now - this.calmSince > TARGET_CALM_SECONDS * 1000 && this.targetSeconds > START_TARGET_SECONDS) {
      this.targetSeconds = Math.max(START_TARGET_SECONDS, this.targetSeconds - TARGET_SHRINK_SECONDS);
      this.calmSince = now;
    }
  }

  // A voice is a signal at a position. `motion` is cells per step, for moving sources.
  addVoice(source, position, motion = { dx: 0, dy: 0 }) {
    const voice = {
      source,
      x: position.x,
      y: position.y,
      dx: motion.dx,
      dy: motion.dy,
      diff: new SourceFilter(),
      tail: 2,
      muted: false,
    };
    this.voices = [...this.voices, voice];
    return voice;
  }

  removeVoice(voice) {
    this.voices = this.voices.filter((v) => v !== voice);
  }

  setEars(left, right) {
    this.earsTarget = { left, right };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }

  setMode(mode, { stepsPerFrame = 0 } = {}) {
    const wasLive = this.mode === 'live';
    this.mode = mode;
    this.dilatedStepsPerFrame = stepsPerFrame;
    this.dilatedRemainder = 0;
    this.pendingSingleSteps = 0;
    if (mode === 'live' && !wasLive) {
      // Audio resumes from this point, not from where it stopped.
      this.configureAudio();
    } else if (mode !== 'live' && wasLive) {
      this.port?.postMessage({ type: 'hold' });
    }
  }

  // Flip the direction of time, exactly: the field reverses, and the source log reverses too.
  reverseTime() {
    this.engine.reverse();
    this.direction = -this.direction;
  }

  // Going forward from the past makes a new future.
  commitForward() {
    if (this.direction === 1 && this.stepClock < this.log.end) this.log.truncate(this.stepClock);
  }

  stepsWanted() {
    const target = this.targetSeconds * this.rate + RESAMPLER_TAPS;
    return Math.floor(this.consumed + target - this.scheduled);
  }

  tick() {
    if (!this.engine.grid || !this.port) return;
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    if (this.mode === 'live') {
      const wanted = this.stepsWanted();
      const minimum = Math.ceil(MIN_BATCH_SECONDS * this.rate);
      if (wanted < minimum) return;
      this.relaxTarget();
      this.runSteps(Math.min(wanted, maxLiveBatch(this.rate)));
    } else if (this.pendingSingleSteps > 0) {
      this.runSteps(Math.min(MAX_BATCH_STEPS, this.pendingSingleSteps));
    }
  }

  // Called once per display frame while time is dilated.
  frameTick() {
    if (this.mode !== 'dilated' || !this.engine.grid) return;
    this.dilatedRemainder += this.dilatedStepsPerFrame;
    const whole = Math.floor(this.dilatedRemainder);
    if (whole <= 0) return;
    this.dilatedRemainder -= whole;
    this.pendingSingleSteps += whole;
  }

  singleStep(count = 1) {
    this.pendingSingleSteps += count;
  }

  renderVoices(count) {
    const active = this.voices.filter((v) => !v.muted).slice(0, MAX_INJECTORS);
    const samples = new Float32Array(count * active.length);
    const scale = sourceScale(this.rate);
    this.inputScratch.fill(0, 0, count);
    active.forEach((voice, s) => {
      voice.source.render(this.scratch, count, this.stepClock);
      for (let n = 0; n < count; n += 1) this.inputScratch[n] += this.scratch[n];
      voice.diff.process(this.scratch, count);
      for (let n = 0; n < count; n += 1) samples[n * active.length + s] = this.scratch[n] * scale;
    });
    // A voice told to go somewhere glides there across the batch. Moving smoothly is what
    // gives a dragged source a true Doppler shift rather than a series of clicks. It can't
    // move faster than half the speed of sound, however fast the pointer goes.
    for (const voice of active) {
      if (voice.target) {
        const limit = MAX_SOURCE_SPEED * count;
        const dx = voice.target.x - voice.x;
        const dy = voice.target.y - voice.y;
        const distance = Math.hypot(dx, dy);
        const scale = distance > limit ? limit / distance : 1;
        voice.dx = (dx * scale) / count;
        voice.dy = (dy * scale) / count;
        if (scale === 1) voice.target = null;
      } else {
        voice.dx = 0;
        voice.dy = 0;
      }
    }
    const injectors = active.map((v) => ({ x: v.x, y: v.y, dx: v.dx, dy: v.dy }));
    for (const voice of active) {
      voice.x += voice.dx * count;
      voice.y += voice.dy * count;
    }
    this.voices = this.voices.filter((v) => {
      if (!v.source.done) return true;
      v.tail -= 1;
      return v.tail > 0;
    });
    return { samples, injectors, input: this.inputScratch.slice(0, count) };
  }

  // Ears move smoothly across a batch, so walking around makes no zipper noise.
  earTaps(count) {
    const from = this.ears;
    const to = this.earsTarget ?? from;
    const motion = (a, b) => ({ x: a.x, y: a.y, dx: (b.x - a.x) / count, dy: (b.y - a.y) / count });
    const taps = [motion(from.left, to.left), motion(from.right, to.right)];
    this.ears = to;
    this.earsTarget = null;
    return taps;
  }

  // Where this batch's source values come from: the live voices, or the log when replaying a
  // stretch of time that has already happened.
  planSources(requested) {
    let count = requested;
    if (this.stopAtStep !== null) {
      count = Math.min(count, Math.abs(this.stopAtStep - this.stepClock));
    }
    if (this.direction === -1) {
      const back = this.log.backwardFrom(this.stepClock, count);
      if (!back) return null;
      return { ...back, input: new Float32Array(back.count) };
    }
    if (this.stepClock < this.log.end) {
      const forward = this.log.forwardFrom(this.stepClock, count);
      if (forward) return { ...forward, input: new Float32Array(forward.count) };
    }
    const fresh = this.renderVoices(count);
    if (this.loggingEnabled) this.log.record(this.stepClock, count, fresh.injectors, fresh.samples);
    return { count, ...fresh };
  }

  runSteps(requested) {
    if (this.stopAtStep === this.stepClock) {
      this.reachStop();
      return;
    }
    const plan = this.planSources(requested);
    if (!plan) {
      this.reachStop();
      return;
    }
    const { count } = plan;
    if (this.mode !== 'live') this.pendingSingleSteps = Math.max(0, this.pendingSingleSteps - count);

    const taps = [...this.earTaps(count), ...this.extraTaps.map((p) => ({ x: p.x, y: p.y, dx: 0, dy: 0 }))];
    const captures = this.planCaptures(count);
    const started = performance.now();
    const checkpoint = this.planCheckpoint(count);
    const batch = this.engine.runBatch(count, {
      injectors: plan.injectors,
      taps,
      samples: plan.samples,
      energyEvery: this.energyEvery,
      captures,
      checkpoint,
    });
    const isLive = this.mode === 'live';
    if (isLive) this.scheduled += count;
    this.stepClock += count * this.direction;
    this.inFlight += 1;
    const allocation = this.engine.fields;
    const session = this.audioSession;
    // Samples that were promised to the audio thread and will never arrive have to be taken
    // back off the books, or the buffer stays that much short for good. Not if the audio
    // has been restarted since, because that already set the count back to zero.
    const unschedule = () => {
      if (isLive && session === this.audioSession) this.scheduled -= count;
    };
    batch.then((values) => {
      this.inFlight -= 1;
      this.batchMs = performance.now() - started;
      this.lastCount = count;
      // The room was replaced while this batch was in flight. Its samples belong to a room
      // that no longer exists, so they're dropped rather than played into the new one.
      if (this.engine.fields !== allocation) {
        unschedule();
        return;
      }
      if (values === null) {
        // No free staging buffer: these steps did not run. Forget we asked for them.
        unschedule();
        this.stepClock -= count * this.direction;
        this.dropped += 1;
        return;
      }
      this.gpuMs = this.engine.lastGpuMs ?? this.gpuMs;
      this.deliver(values, count, taps.length, plan.input, isLive);
    }).catch(() => {
      this.inFlight -= 1;
      unschedule();
      // A read cancelled by a room change is expected. Any other failure is a real one.
      if (this.engine.fields === allocation) this.errors += 1;
    });
    if (this.stopAtStep !== null && this.stepClock === this.stopAtStep) this.reachStop();
  }

  reachStop() {
    const stop = this.onStop;
    this.stopAtStep = null;
    this.pendingSingleSteps = 0;
    this.onStop = null;
    stop?.();
  }

  // Checkpoints are only taken going forward, when no replay is underway.
  planCheckpoint(count) {
    if (this.direction !== 1 || this.stepClock + count < this.nextCheckpoint) return null;
    const { slots } = this.engine;
    if (!slots) return null;
    const stepAfter = this.stepClock + count;
    if (this.checkpoints.some((c) => c.step === stepAfter)) return null;
    const slot = this.checkpoints.length < slots
      ? this.checkpoints.length
      : this.checkpoints.reduce((oldest, c, n, all) => (c.step < all[oldest].step ? n : oldest), 0);
    this.checkpoints[slot] = { step: stepAfter, slot };
    this.nextCheckpoint = stepAfter + this.checkpointEvery;
    return slot;
  }

  // Latest checkpoint at or before a step, for going back by replaying forward.
  checkpointBefore(step) {
    let best = null;
    for (const c of this.checkpoints) {
      if (c && c.step <= step && (!best || c.step > best.step)) best = c;
    }
    return best;
  }

  // Captures are in steps from the start of this batch, sorted, and may include a frame for
  // the display (slot 0) and the field-history schedule.
  planCaptures(count) {
    const captures = [];
    if (this.extraCaptures?.length) {
      const due = this.extraCaptures.filter((c) => c.atStep > this.stepClock && c.atStep <= this.stepClock + count);
      for (const c of due) captures.push({ step: c.atStep - this.stepClock, frame: c.frame });
      this.extraCaptures = this.extraCaptures.filter((c) => c.atStep > this.stepClock + count);
    }
    if (this.captureSchedule) {
      const schedule = this.captureSchedule;
      while (schedule.remaining > 0 && schedule.nextStep <= count) {
        captures.push({ step: Math.max(1, schedule.nextStep), frame: schedule.frame });
        schedule.stamps?.push(this.stepClock + Math.max(1, schedule.nextStep) * this.direction);
        schedule.frame += 1;
        schedule.remaining -= 1;
        schedule.nextStep += schedule.every;
      }
      schedule.nextStep -= count;
      schedule.captured = schedule.total - schedule.remaining;
      if (schedule.remaining <= 0) {
        this.lastHistory = schedule;
        this.captureSchedule = null;
      }
    }
    if (this.captureNext) {
      const step = Math.max(1, Math.min(count, this.captureNext(count)));
      captures.push({ step, frame: 0 });
      this.captureNext = null;
    }
    captures.sort((a, b) => a.step - b.step);
    return captures;
  }

  // Ask for the next batch to copy the field to the display slot. `pick(count)` chooses which
  // step, which is how the strobe view locks to a tone.
  requestDisplay(pick = (count) => count) {
    this.captureNext = pick;
  }

  startHistory({ frames, firstFrame, everySteps, stamps = null }) {
    this.captureSchedule = {
      remaining: frames,
      total: frames,
      frame: firstFrame,
      every: everySteps,
      nextStep: 1,
      captured: 0,
      stamps,
    };
  }

  deliver(values, count, tapCount, input, isLive) {
    if (isLive && this.port) {
      const frames = new Float32Array(count * 2);
      for (let n = 0; n < count; n += 1) {
        frames[n * 2] = values[n * tapCount];
        frames[n * 2 + 1] = values[n * tapCount + 1];
      }
      this.produced += count;
      this.port.postMessage({ type: 'frames', data: frames }, [frames.buffer]);
    }
    if (this.onBatch) this.onBatch(values, count, tapCount, input);
  }

  stats() {
    return {
      rate: this.rate,
      steps: this.stepClock,
      produced: this.produced,
      consumed: this.consumed,
      underruns: this.underruns,
      dropped: this.dropped,
      errors: this.errors,
      targetSeconds: this.targetSeconds,
      batchMs: this.batchMs,
      gpuMs: this.gpuMs,
      lastCount: this.lastCount,
      limiterReduction: this.limiterReduction,
      outputPeak: this.outputPeak,
      mode: this.mode,
      direction: this.direction,
    };
  }
}
