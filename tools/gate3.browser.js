// Browser gate for Phase 3, loaded into the running app. It drives the real GPU path and reports
// measurements on window.hollowGate3. Nothing here downloads a file: exports are decoded in place.
(async () => {
  const h = window.hollow;
  for (let i = 0; i < 80 && !h.active; i += 1) await new Promise((r) => setTimeout(r, 250));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  await h.ensureAudio();
  // Quiet without touching the person's saved volume.
  h.output.setGain(0.00005);
  const out = {};
  const { makeScene, SCENES } = await import('/src/scene/presets.js');
  const { createRoom, addObject } = await import('/src/scene/room.js');
  const { convolve } = await import('/src/features/lab/measure.js');
  const { decodeWav } = await import('/src/audio/wav.js');
  const { impulseResponseWav } = await import('/src/audio/ir.js');
  const { CHALLENGES, CHALLENGE_RATE, challengeByKey } = await import('/src/features/challenges/definitions.js');

  // Interference at the real ears, with the speakers placed by the app's own button.
  const earRms = async () => {
    await wait(800);
    let sum = 0;
    let n = 0;
    const off = h.addSampleListener((m) => {
      for (let i = 0; i < m.count; i += 1) {
        const v = m.values[i * m.taps];
        sum += v * v;
        n += 1;
      }
    });
    await wait(1000);
    off();
    return Math.sqrt(sum / (n || 1));
  };
  await h.loadRoom(createRoom({
    name: 'Interference', width: 8, height: 6, edges: 'open', airLoss: 1, ear: { x: 4, y: 3, angle: 0 },
  }));
  h.openWorkspace('sources');
  await wait(200);
  h.active.setupPair(0);
  const both = await earRms();
  h.active.setupPair(Math.PI);
  const anti = await earRms();
  h.commit({ ...h.room, speakers: h.room.speakers.slice(0, 1) });
  const one = await earRms();
  h.commit({ ...h.room, speakers: [] });
  out.interference = {
    one, both, anti, inPhaseDb: 20 * Math.log10(both / one), antiPhaseDb: 20 * Math.log10(anti / one),
  };

  // The GPU's impulse response must predict what the GPU does directly.
  const room = addObject(addObject(createRoom({
    width: 4, height: 3, airLoss: 4, ear: { x: 3, y: 2, angle: 0 },
  }), {
    type: 'wall', points: [{ x: 2, y: 0 }, { x: 2, y: 1.6 }], thickness: 0.2, material: 'wood',
  }), { type: 'rect', x: 0.6, y: 2.5, w: 0.8, h: 0.5, material: 'foam' });
  const point = { x: 0.8, y: 1 };
  const ir = await h.sim.request('bake', {
    room, sources: [{ point, stimulus: { kind: 'impulse' } }], listeners: 'ears', seconds: 1, rate: 16000,
  });
  const clap = await h.sim.request('bake', {
    room, sources: [{ point, stimulus: { kind: 'clap', seed: 7 } }], listeners: 'ears', seconds: 1, rate: 16000,
  });
  const { ClapSource } = await import('/src/audio/sources.js');
  const source = new ClapSource(16000, 1, 7);
  const signal = new Float32Array(16000);
  source.render(signal, signal.length);
  const predicted = convolve(signal, ir.traces[0], signal.length);
  let error = 0;
  let power = 0;
  for (let n = 0; n < signal.length; n += 1) {
    error += (predicted[n] - clap.traces[0][n]) ** 2;
    power += clap.traces[0][n] ** 2;
  }
  const decoded = decodeWav(impulseResponseWav(ir.traces[0], ir.traces[1], ir.rate, { bits: 24 }));
  const peak = decoded.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  out.impulseResponse = {
    residualDb: 10 * Math.log10(error / power),
    wav: {
      rate: decoded.rate, bits: decoded.bits, channels: decoded.channels.length, frames: decoded.channels[0].length, peak, note: decoded.note,
    },
  };

  // GPU and CPU agree on challenge results. Every family, starting room and solution.
  const simulate = (request) => h.sim.request('bake', request);
  const families = [...new Set(CHALLENGES.map((c) => c.family))];
  out.challenges = {};
  for (const family of families) {
    const c = CHALLENGES.find((x) => x.family === family && x.level === 1);
    const start = await c.test(c.start(), simulate);
    const solved = await c.test(c.reference(c.start()), simulate);
    out.challenges[family] = {
      startPass: start.pass,
      solvedPass: solved.pass,
      solved: solved.rows.map((r) => `${r.ok ? 'ok' : 'NO'} ${r.label}: ${r.measured}`),
    };
  }
  out.challengeRate = CHALLENGE_RATE;

  // The challenge interface, driven through its own controls.
  h.openWorkspace('challenges');
  await wait(200);
  const cw = h.active;
  const gallery = challengeByKey('gallery-0');
  await cw.open(gallery);
  await cw.runTest();
  out.challengeUi = { startOutcome: cw.outcome?.pass };
  h.commit(gallery.reference(h.room));
  await wait(200);
  await cw.runTest();
  out.challengeUi.solvedOutcome = cw.outcome?.pass;
  out.challengeUi.panelSaysSolved = h.dom.panel.textContent.includes('Solved.');
  out.challengeUi.explains = h.dom.panel.textContent.includes('Why it worked');

  // Every scene loads and accepts a clap.
  out.scenes = {};
  for (const scene of SCENES) {
    await h.loadRoom(makeScene(scene.key));
    h.sim.send('clap', { point: { x: h.room.width * 0.3, y: h.room.height * 0.45 } });
    await wait(250);
    const { stats, level } = await h.sim.request('stats');
    out.scenes[scene.key] = { level: +level.toExponential(2), errors: stats.errors, rate: stats.rate };
  }

  // A real take, through the Studio's recorder, saved in chunks and read back.
  await h.loadRoom(makeScene('cathedral'));
  h.openWorkspace('studio');
  await wait(200);
  const studio = h.active;
  await studio.toggleRecording();
  h.sim.send('clap', { point: { x: 6, y: 4.5 } });
  await wait(2200);
  await studio.toggleRecording();
  const takes = await studio.recorder.list();
  const take = takes[0];
  const loaded = await studio.recorder.load(take);
  const takePeak = loaded.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  out.studio = {
    takes: takes.length,
    open: take.open,
    frames: take.frames,
    chunks: take.chunks,
    seconds: take.frames / take.rate,
    peak: takePeak,
    roomKept: take.room?.name,
  };
  await studio.recorder.remove(take);

  out.errs = errs.slice(0, 3);
  out.status = h.dom.readout.textContent;
  out.toast = h.dom.toast.textContent;
  h.output.setGain(h.volume);
  window.hollowGate3 = out;
})().catch((error) => {
  window.hollowGate3 = { failed: error.message, stack: error.stack };
});
