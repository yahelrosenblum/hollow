// Phase 2 browser gate. Pasted into the page: drives the real app and reports measurements.
(async () => {
  const h = window.hollow;
  for (let i = 0; i < 80 && !h.active; i += 1) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 400));
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  await h.ensureAudio();
  // Quiet without touching the person's saved volume.
  h.output.setGain(0.00005);
  const { makeScene } = await import('/src/scene/presets.js');
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Clean refocus
  await h.loadRoom(makeScene('time-mirror'));
  h.openWorkspace('time');
  await wait(300);
  const scores = [];
  h.sim.on('refocus', (m) => scores.push(m.score));
  const runMirror = async (disturb) => {
    const n = scores.length;
    h.sim.send('clap', { point: { x: 2.4, y: 2.6 } });
    await wait(500);
    await h.sim.request('timeRewind', { divisor: 1 });
    if (disturb) {
      await wait(60);
      const { addObject } = await import('/src/scene/room.js');
      h.commit(addObject(h.room, { type: 'wall', points: [{ x: 7, y: 3 }, { x: 8, y: 4.5 }], thickness: 0.15, material: 'mirror' }));
    }
    const t0 = performance.now();
    while (scores.length === n && performance.now() - t0 < 9000) await wait(100);
    const score = scores[n];
    await h.sim.request('timeLive');
    await wait(200);
    return score;
  };
  out.cleanRefocus = await runMirror(false);
  await h.loadRoom(makeScene('time-mirror'));
  await wait(200);
  out.disturbedRefocus = await runMirror(true);

  // Checkpoint replay in a lossy room must reproduce the same state exactly.
  await h.loadRoom(makeScene('cathedral'));
  await wait(200);
  h.sim.send('clap', { point: { x: 6, y: 4.5 } });
  await wait(1200);
  await h.sim.request('timePause');
  await wait(300);
  const a = await h.sim.request('readFieldForTest');
  const back = await h.sim.request('timeStepBack', { count: 300 });
  await wait(600);
  const b = await h.sim.request('readFieldForTest');
  await h.sim.request('timeStepForward', { count: 300 });
  await wait(600);
  const c = await h.sim.request('readFieldForTest');
  let differ = 0;
  let maxDiff = 0;
  let movedDiff = 0;
  for (let i = 0; i < a.cur.length; i += 1) {
    if (a.cur[i] !== c.cur[i]) differ += 1;
    maxDiff = Math.max(maxDiff, Math.abs(a.cur[i] - c.cur[i]));
    movedDiff = Math.max(movedDiff, Math.abs(a.cur[i] - b.cur[i]));
  }
  out.checkpointReplay = {
    method: back, stepA: a.step, stepB: b.step, stepC: c.step, cellsDiffering: differ, maxDiff, movedDiff,
  };

  // Reversal refused in a lossy room
  out.rewindRefused = await h.sim.request('timeRewind', { divisor: 8 });
  await h.sim.request('timeLive');
  await wait(200);

  // Record and playback
  await h.sim.request('timeRecord');
  h.sim.send('clap', { point: { x: 6, y: 4.5 } });
  await wait(1000);
  out.playback = await h.sim.request('timePlayback', { speed: 2 });
  await wait(500);
  const st = h.active.timeState;
  out.playbackState = { kind: st?.kind, playback: st?.playback, badge: h.dom.timeBadge.textContent };
  await h.sim.request('timeLive');

  // Live interference, using the speakers and the real ears.
  await h.loadRoom(makeScene('double-slit'));
  const { createRoom } = await import('/src/scene/room.js');
  const earRms = async () => {
    await wait(700);
    let sum = 0;
    let n = 0;
    const off = h.addSampleListener((m) => {
      for (let i = 0; i < m.count; i += 1) {
        const v = m.values[i * m.taps];
        sum += v * v;
        n += 1;
      }
    });
    await wait(900);
    off();
    return Math.sqrt(sum / (n || 1));
  };
  await h.loadRoom(createRoom({ name: 'Interference', width: 8, height: 6, edges: 'open', airLoss: 1, ear: { x: 4, y: 3, angle: 0 } }));
  // Ahead of and behind the listener, the only line on which both ears are equidistant from both.
  const sp = (id, x, phase) => ({ id, name: id, x, y: 3, signal: 'tone', frequency: 700, phase, delay: 0, gain: 0.25, on: true });
  h.commit({ ...h.room, speakers: [sp('a', 2.5, 0)] });
  const one = await earRms();
  h.commit({ ...h.room, speakers: [sp('a', 2.5, 0), sp('b', 5.5, 0)] });
  const both = await earRms();
  h.commit({ ...h.room, speakers: [sp('a', 2.5, 0), sp('b', 5.5, Math.PI)] });
  const anti = await earRms();
  h.commit({ ...h.room, speakers: [] });
  out.liveInterference = {
    one, both, anti,
    inPhaseDb: 20 * Math.log10(both / one),
    antiDb: 20 * Math.log10(anti / one),
  };

  // Measure, compare, perf
  await h.loadRoom(makeScene('cathedral'));
  h.openWorkspace('lab');
  await wait(300);
  await h.active.measure();
  const m = h.active.measured;
  out.measure = {
    decay: m?.analysis.decay,
    seconds: m?.seconds,
    arrivalMs: m && m.analysis.arrival * 1000,
    modes: m?.analysis.modes.slice(0, 4).map((x) => +x.hz.toFixed(1)),
  };
  h.openWorkspace('perf');
  await wait(1200);
  const perf = h.active.history;
  const sample = perf.samples[perf.samples.length - 1];
  out.perf = {
    samples: perf.samples.length, sample, panel: h.dom.panel.querySelector('.metrics')?.textContent.slice(0, 200), timing: h.stats?.timing,
  };
  out.status = h.dom.readout.textContent;
  out.errs = errs.slice(0, 3);
  out.toast = h.dom.toast.textContent;
  h.output.setGain(h.volume);
  window.hollowGate2 = out;
  return out;
})();
