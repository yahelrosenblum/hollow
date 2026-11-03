// The time laboratory, on the simulation side. Three different things are called "going
// backward", and they are kept strictly apart, because only one of them is physics:
//
//  reversed    The solver itself runs backward. Exact, but only valid in a lossless room:
//              undoing a loss means amplifying, which amplifies rounding errors too.
//  resim       Restore an earlier checkpoint and re-run forward to the wanted step. Exact and
//              stable in any room, because no equation ever runs in reverse.
//  playback    Stored pictures of the field, shown in any order. Not a simulation at all.

import { refocusScore } from '../features/lab/measure.js';
import { SOURCE_DELAY_STEPS } from '../audio/sources.js';

// A lossless room's clap is a very short pulse, so there's a real point for sound to gather
// back to. The reference moment is just after it, when it's still a small ring.
export const MIRROR_PULSE_SECONDS = 0.0015;
const REFERENCE_AFTER_SECONDS = 0.002;
const FOCUS_DIAMETER_METRES = 1.8;
const HISTORY_SECONDS_PER_FRAME = 0.0007;

export class TimeControl {
  constructor({ host, engine, post, getRoom, getSize, getCompiled, onStateChange }) {
    this.host = host;
    this.engine = engine;
    this.post = post;
    this.getRoom = getRoom;
    this.getSize = getSize;
    this.getCompiled = getCompiled;
    this.onStateChange = onStateChange;
    this.kind = 'live';
    this.reference = null;
    this.perturbed = false;
    this.playback = null;
    this.compare = false;
    this.stamps = [];
    this.speedDivisor = 1;
  }

  get frameRate() {
    return 60;
  }

  isLossless() {
    const room = this.getRoom();
    const hasReed = room.objects.some((o) => o.material === 'reed');
    return room.lossless === true && !hasReed;
  }

  setKind(kind) {
    this.kind = kind;
    this.onStateChange?.();
    this.report();
  }

  report() {
    const { host } = this;
    const earliest = host.log.start;
    this.post('time-state', {
      kind: this.kind,
      step: host.stepClock,
      rate: host.rate,
      lossless: this.isLossless(),
      perturbed: this.perturbed,
      canStepBack: this.isLossless()
        ? host.stepClock > earliest
        : host.checkpoints.some((c) => c && c.step < host.stepClock),
      earliestStep: earliest,
      latestStep: host.log.end,
      speedDivisor: this.speedDivisor,
      reference: this.reference ? { step: this.reference.step } : null,
      playback: this.playback ? {
        position: this.playback.position, frames: this.playback.frames, speed: this.playback.speed,
      } : null,
      compare: this.compare,
    });
  }

  forward() {
    if (this.host.direction === -1) this.host.reverseTime();
  }

  backward() {
    if (this.host.direction === 1) this.host.reverseTime();
  }

  clearStops() {
    this.host.stopAtStep = null;
    this.host.onStop = null;
  }

  live() {
    this.clearStops();
    this.playback = null;
    this.compare = false;
    this.forward();
    this.host.commitForward();
    this.host.setMode('live');
    this.speedDivisor = 1;
    this.setKind('live');
  }

  pause() {
    this.clearStops();
    this.host.setMode('paused');
    this.setKind('paused');
  }

  // Slows the solver itself. There's no audio at these speeds; a sound slowed by this much
  // would be below hearing, and playing anything else would misrepresent it.
  slow(divisor) {
    this.clearStops();
    this.playback = null;
    this.forward();
    this.speedDivisor = divisor;
    this.host.setMode('dilated', { stepsPerFrame: this.host.rate / this.frameRate / divisor });
    this.setKind('slow');
  }

  stepForward(count) {
    this.clearStops();
    this.playback = null;
    this.forward();
    if (this.host.mode === 'live') this.host.setMode('paused');
    this.host.stopAtStep = this.host.stepClock + count;
    this.host.onStop = () => {
      this.host.setMode('paused');
      this.setKind('paused');
    };
    this.host.singleStep(count);
    this.setKind(this.host.stepClock < this.host.log.end ? 'resim' : 'paused');
  }

  // Backward by the exact method where that's valid, and by re-simulation everywhere else.
  stepBack(count) {
    this.clearStops();
    this.playback = null;
    const { host } = this;
    if (host.mode === 'live') host.setMode('paused');
    if (this.isLossless() && !this.perturbed) {
      const target = Math.max(host.log.start, host.stepClock - count);
      if (target >= host.stepClock) {
        this.setKind('paused');
        return { ok: false, reason: 'This is the earliest moment Hollow has kept.' };
      }
      this.backward();
      host.stopAtStep = target;
      host.onStop = () => {
        this.forward();
        host.setMode('paused');
        this.setKind('paused');
      };
      host.singleStep(host.stepClock - target);
      this.setKind('reversed');
      return { ok: true, method: 'reversed' };
    }
    return this.resimulateTo(host.stepClock - count);
  }

  resimulateTo(target) {
    const { host, engine } = this;
    this.forward();
    const checkpoint = host.checkpointBefore(target);
    if (!checkpoint) {
      this.setKind('paused');
      return { ok: false, reason: 'That is further back than Hollow has kept.' };
    }
    engine.restoreCheckpoint(checkpoint.slot);
    host.stepClock = checkpoint.step;
    if (target === checkpoint.step) {
      this.setKind('paused');
      return { ok: true, method: 'resim' };
    }
    host.stopAtStep = target;
    host.onStop = () => {
      host.setMode('paused');
      this.setKind('paused');
    };
    host.singleStep(target - checkpoint.step);
    this.setKind('resim');
    return { ok: true, method: 'resim' };
  }

  // Run the solver backward. Stops by itself at the moment just after the last clap, which is
  // where a refocus can be scored.
  rewind(divisor) {
    if (!this.isLossless()) {
      return { ok: false, reason: 'Reversing a room with any loss would amplify rounding errors until it blew up. Only perfect walls and still air can run backward. Use Record for a playback, or step back to re-simulate.' };
    }
    this.clearStops();
    this.playback = null;
    this.backward();
    this.speedDivisor = divisor;
    const { host } = this;
    host.setMode('dilated', { stepsPerFrame: host.rate / this.frameRate / divisor });
    if (this.reference && host.stepClock > this.reference.step) {
      host.stopAtStep = this.reference.step;
      host.onStop = () => this.onReachedReference();
    } else {
      host.stopAtStep = host.log.start;
      host.onStop = () => {
        this.forward();
        host.setMode('paused');
        this.setKind('paused');
      };
    }
    this.setKind('reversed');
    return { ok: true };
  }

  // Called for each clap in a lossless room: remembers the field shortly after, so the
  // return journey has something exact to be measured against.
  noteClap(centre) {
    if (!this.isLossless() || this.kind === 'reversed') return;
    const { host, engine } = this;
    const step = host.stepClock + Math.round(host.rate * REFERENCE_AFTER_SECONDS) + SOURCE_DELAY_STEPS;
    const frame = engine.frameCount - 1;
    host.extraCaptures = [{ atStep: step, frame }];
    this.reference = { step, frame, centre };
    this.perturbed = false;
    this.lastScore = null;
  }

  // After the grid is rebuilt, everything recorded belongs to a room that no longer exists.
  resetForNewGrid() {
    const { host } = this;
    this.reference = null;
    this.playback = null;
    this.compare = false;
    this.stamps = [];
    this.perturbed = false;
    host.lastHistory = null;
    host.captureSchedule = null;
    host.extraCaptures = [];
    host.stopAtStep = null;
    host.onStop = null;
    if (host.mode !== 'live') host.setMode('live');
    this.speedDivisor = 1;
    if (this.kind !== 'live') this.setKind('live');
  }

  async onReachedReference() {
    const { host, engine, reference } = this;
    host.setMode('paused');
    this.setKind('paused');
    if (!reference) return;
    // In a reversed run, the state belonging to this step is the older field.
    await engine.device.queue.onSubmittedWorkDone();
    const [field, original] = await Promise.all([engine.readField('prev'), engine.readFrame(reference.frame)]);
    const size = this.getSize();
    const score = refocusScore(field, original, this.getCompiled().flags, {
      nx: size.nx,
      centre: reference.centre,
      dx: size.dx,
      wavelength: FOCUS_DIAMETER_METRES,
    });
    this.forward();
    this.lastScore = { ...score, perturbed: this.perturbed };
    this.post('refocus', { score: this.lastScore });
  }

  noteRoomChange() {
    if (this.kind === 'reversed') this.perturbed = true;
    this.host.invalidateCheckpoints();
  }

  // --- playback of stored pictures ---

  recordHistory() {
    const { host, engine } = this;
    const everySteps = Math.max(1, Math.round(host.rate * HISTORY_SECONDS_PER_FRAME));
    const frames = Math.max(1, engine.frameCount - 2);
    this.stamps = [];
    host.startHistory({ frames, firstFrame: 1, everySteps, stamps: this.stamps });
    this.historyFrames = frames;
    return { frames, seconds: (frames * everySteps) / host.rate };
  }

  startPlayback(speed) {
    const captured = this.host.lastHistory?.captured ?? this.host.captureSchedule?.captured ?? 0;
    if (captured < 2) return { ok: false, reason: 'Record first, then play it back.' };
    this.host.setMode('paused');
    this.playback = {
      position: speed >= 0 ? 0 : captured - 1,
      frames: captured,
      speed,
      playing: true,
    };
    this.setKind('playback');
    return { ok: true, frames: captured };
  }

  setPlayback({ position, speed, playing }) {
    if (!this.playback) return;
    if (position !== undefined) this.playback.position = Math.max(0, Math.min(this.playback.frames - 1, position));
    if (speed !== undefined) this.playback.speed = speed;
    if (playing !== undefined) this.playback.playing = playing;
    this.report();
  }

  // Which stored picture to show this display frame, or null when there's no playback.
  playbackFrame() {
    const { playback } = this;
    if (!playback) return null;
    if (playback.playing) {
      playback.position += playback.speed;
      this.playbackTicks = (this.playbackTicks ?? 0) + 1;
      const atEnd = playback.speed > 0 ? playback.position >= playback.frames - 1 : playback.position <= 0;
      if (atEnd) {
        playback.position = Math.max(0, Math.min(playback.frames - 1, playback.position));
        playback.playing = false;
        this.report();
      } else if (this.playbackTicks % 6 === 0) {
        // Nothing else reports while the solver is stopped, and the scrubber needs to move.
        this.report();
      }
    }
    return 1 + Math.round(playback.position);
  }

  // The stored forward picture of the moment the field is at now, if there is one.
  matchingFrame(step) {
    if (!this.stamps.length) return null;
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < this.stamps.length; i += 1) {
      const gap = Math.abs(this.stamps[i] - step);
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    return bestGap <= Math.round(this.host.rate * HISTORY_SECONDS_PER_FRAME) ? 1 + best : null;
  }
}
