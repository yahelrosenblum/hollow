// The time laboratory. The badge on the field always says which kind of "backward" is
// happening, because they are different things and only one of them is the physics reversing.

import { button, el, metrics, slider } from '../../app/dom.js';

const BADGES = {
  reversed: ['SOLVER REVERSED', 'reversed', 'The equations are running backward. This is exact, and only possible with no loss in the room.'],
  resim: ['RE-SIMULATED', 'resim', 'Replaying forward from a saved moment. Exact in any room, because nothing runs in reverse.'],
  playback: ['PLAYBACK', 'playback', 'Showing stored pictures of the field. This is a recording, not a simulation.'],
  paused: ['PAUSED', '', 'The solver is stopped. Step it one sample at a time.'],
  slow: ['SLOW MOTION', '', 'The solver itself is running slowly. Sound at this speed would be below hearing, so there is none.'],
  live: [null, '', 'Running live, in step with the audio.'],
};

const SPEEDS = [8, 32, 128, 512];

function msFromSteps(steps, rate) {
  return ((steps / rate) * 1000).toFixed(2);
}

export function timelabWorkspace(app) {
  const state = { time: null, score: null, unsubscribe: [], rewindDivisor: SPEEDS[1] };
  let clock;
  let describe;
  let scoreOut;
  let playbackRow;
  let buttons = {};

  function request(type, payload) {
    return app.sim.request(type, payload).catch((error) => app.toast(error.message));
  }

  async function stepBack(count) {
    const result = await request('timeStepBack', { count });
    if (result && result.ok === false) app.toast(result.reason);
  }

  function onGridChanged() {
    state.score = null;
    app.setTimeBadge(null);
  }

  async function rewind(divisor) {
    const result = await request('timeRewind', { divisor });
    if (result && result.ok === false) app.toast(result.reason);
  }

  async function record() {
    const info = await request('timeRecord');
    if (info) app.toast(`Recording ${(info.seconds * 1000).toFixed(0)} ms of the field. Clap now.`);
  }

  async function playback(speed) {
    const result = await request('timePlayback', { speed });
    if (result && result.ok === false) app.toast(result.reason);
  }

  function onState(message) {
    state.time = message;
    const [badge, kind] = BADGES[message.kind] ?? BADGES.live;
    app.setTimeBadge(badge, kind);
    render.update?.();
  }

  function onScore({ score }) {
    state.score = score;
    render.update?.();
    app.announce(`Refocus: ${Math.round(score.correlation * 100)} percent match`);
  }

  function renderScore() {
    const s = state.score;
    if (!s) return;
    scoreOut.cells.correlation.textContent = `${(s.correlation * 100).toFixed(2)}%`;
    scoreOut.cells.energy.textContent = `${(s.energyFraction * 100).toFixed(1)}%`;
    scoreOut.cells.spot.textContent = `${(s.spotWidth * 100).toFixed(0)} cm`;
    scoreOut.cells.state.textContent = s.perturbed ? 'Disturbed on the way back' : 'Undisturbed';
  }

  function render() {
    buttons = {};
    clock = metrics([
      { key: 'time', label: 'Simulated time', big: true },
      { key: 'step', label: 'Solver step' },
      { key: 'kind', label: 'Mode' },
    ]);
    describe = el('p', { class: 'note', text: BADGES.live[2] });
    scoreOut = metrics([
      { key: 'correlation', label: 'Field matches the original' },
      { key: 'energy', label: 'Energy back near the source' },
      { key: 'spot', label: 'Focal spot width' },
      { key: 'state', label: 'Return journey' },
    ]);
    buttons.pause = button('Pause', () => request('timePause'));
    buttons.resume = button('Live', () => request('timeLive'), { class: 'btn primary' });
    buttons.rewind = button('Rewind time', () => rewind(state.rewindDivisor), { class: 'btn wide primary' });
    const speedButtons = SPEEDS.map((d) => button(`1/${d}`, () => request('timeSlow', { divisor: d })));
    const rewindSpeed = slider({
      label: 'Rewind speed',
      min: 0,
      max: 3,
      step: 1,
      value: SPEEDS.indexOf(state.rewindDivisor),
      format: (v) => `1/${SPEEDS[v]}`,
      oninput: (v) => {
        state.rewindDivisor = SPEEDS[v];
        if (state.time?.kind === 'reversed') rewind(state.rewindDivisor);
      },
    });
    const compare = el('input', {
      type: 'checkbox',
      checked: state.time?.compare ?? false,
      onchange: (event) => request('timeCompare', { on: event.target.checked }),
    });
    playbackRow = el(
      'div',
      { class: 'btn-grid' },
      button('Record', record),
      button('Play', () => playback(0.5)),
      button('Play ×4', () => playback(2)),
      button('Backward', () => playback(-0.5)),
    );
    const scrub = slider({
      label: 'Position',
      min: 0,
      max: 1000,
      step: 1,
      value: 0,
      format: (v) => `${(v / 10).toFixed(0)}%`,
      oninput: (v) => {
        const p = state.time?.playback;
        if (p) request('timeSetPlayback', { position: (v / 1000) * (p.frames - 1), playing: false });
      },
    });
    scrub.input.disabled = true;

    render.update = () => {
      const t = state.time;
      if (!t) return;
      clock.cells.time.textContent = `${msFromSteps(t.step, t.rate)} ms`;
      clock.cells.step.textContent = t.step.toLocaleString('en-US');
      clock.cells.kind.textContent = (BADGES[t.kind]?.[0] ?? 'LIVE').toLowerCase();
      describe.textContent = t.perturbed
        ? 'The room changed during the return. Reversal is now reversing a different room, so it cannot refocus cleanly: this is a Loschmidt echo.'
        : BADGES[t.kind]?.[2] ?? '';
      buttons.rewind.disabled = !t.lossless;
      scrub.input.disabled = !t.playback;
      if (t.playback && document.activeElement !== scrub.input) {
        scrub.set(Math.round((t.playback.position / Math.max(1, t.playback.frames - 1)) * 1000));
      }
      renderScore();
    };
    render.update();

    return [
      el('h2', { text: 'Time' }),
      el('p', { class: 'placard', text: 'Stop the solver, step it one sample at a time, or send it backward.' }),
      clock.node,
      describe,
      el('div', { class: 'btn-row' }, buttons.pause, buttons.resume),
      el('h3', { text: 'Step' }),
      el(
        'div',
        { class: 'btn-grid' },
        button('−100', () => stepBack(100)),
        button('−10', () => stepBack(10)),
        button('−1', () => stepBack(1)),
        button('+1', () => request('timeStepForward', { count: 1 })),
        button('+10', () => request('timeStepForward', { count: 10 })),
        button('+100', () => request('timeStepForward', { count: 100 })),
      ),
      el('p', { class: 'note', text: 'One step is one sample of audio. Stepping back runs the solver in reverse if this room is lossless, and otherwise re-simulates from the last saved moment.' }),
      el('h3', { text: 'Slow motion' }),
      el('div', { class: 'btn-grid' }, speedButtons),
      el('h3', { text: 'Run time backward' }),
      el('p', { class: 'note', text: 'Only rooms with perfect walls and still air can do this. Open the Time mirror room, clap, wait, then rewind and watch the sound gather back to where it began. Draw something while it does, and the refocus breaks.' }),
      buttons.rewind,
      rewindSpeed.row,
      el('label', { class: 'note', style: 'display:flex;gap:8px;align-items:center' }, compare, 'Original beside reversed, using a recording'),
      el('h3', { text: 'How well it refocused' }),
      scoreOut.node,
      el('h3', { text: 'Recording of the field' }),
      el('p', { class: 'note', text: 'Record, clap, then play the stored pictures at any speed, in either direction. This works in any room, and it is a playback, not physics.' }),
      playbackRow,
      scrub.row,
    ];
  }

  return {
    key: 'time',
    label: 'Time',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
      state.unsubscribe = [
        app.sim.on('time-state', onState),
        app.sim.on('refocus', onScore),
        app.sim.on('voices-reset', onGridChanged),
      ];
      request('timeCompare', { on: state.time?.compare ?? false });
    },
    onHide() {
      for (const off of state.unsubscribe) off();
      state.unsubscribe = [];
      app.sim.request('timeLive').catch(() => {});
      app.setTimeBadge(null);
    },
    get timeState() {
      return state.time;
    },
    get score() {
      return state.score;
    },
  };
}
