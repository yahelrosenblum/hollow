// Half an hour of the real app with sound muted and everything running: speakers, claps, doors,
// walls, every workspace. It logs every 30 seconds, including whether the page was visible,
// so a bad stretch can be traced to its cause. It passes on the plan's criterion, solver time
// staying with audio time, plus stability. Real-time rate and dropouts are reported beside it.
const INAUDIBLE_GAIN = 0.00005;
const KEEP_AWAKE_HZ = 30;
const KEEP_AWAKE_GAIN = 0.001;

(async () => {
  const h = window.hollow;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !h.active; i += 1) await wait(250);
  await h.dismissWelcome?.();
  await wait(500);
  const seconds = window.hollowSoakSeconds ?? 1800;
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  h.sim.on('blow-up', () => errs.push('blow-up'));
  window.addEventListener('error', (e) => errs.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push(String(e.reason?.message ?? e.reason)));
  const rateChanges = [];
  h.sim.on('rate-changed', (m) => rateChanges.push({ t: Math.round(performance.now() / 1000), rate: m.rate }));
  await h.ensureAudio();
  h.output.setGain(INAUDIBLE_GAIN);
  const audio = h.output.context;
  // A hidden page's worklets stall unless the page is audibly playing: an empty one stalls the
  // same way. Someone listening is never in that state, but a muted soak is, so it would only
  // measure its own muting. This hum counts as audible and is too low and quiet for speakers.
  const keepAwake = new AudioContext();
  const hum = keepAwake.createOscillator();
  const humGain = keepAwake.createGain();
  hum.frequency.value = KEEP_AWAKE_HZ;
  humGain.gain.value = KEEP_AWAKE_GAIN;
  hum.connect(humGain).connect(keepAwake.destination);
  hum.start();
  await keepAwake.resume();
  const { makeScene } = await import('/src/scene/presets.js');
  const { updateObject, addObject, removeObjects } = await import('/src/scene/room.js');
  await h.loadRoom(makeScene('next-door'));
  h.commit({
    ...h.room,
    speakers: [
      { id: 'a', name: 'A', x: 2, y: 2, signal: 'tone', frequency: 400, phase: 0, delay: 0, gain: 0.2, on: true },
      { id: 'b', name: 'B', x: 3, y: 5, signal: 'noise', frequency: 400, phase: 0, delay: 0, gain: 0.1, on: true },
    ],
  });
  const rows = [];
  const started = performance.now();
  let last = (await h.sim.request('stats')).stats;
  let lastAt = performance.now();
  let lastAudio = audio.currentTime;
  let hiddenSamples = 0;
  let samples = 0;
  const spaces = h.workspaces.map((w) => w.key).filter((k) => k !== 'time');
  let tick = 0;
  let extraId = null;
  let peak = 0;
  const offPeak = h.addSampleListener((m) => {
    for (let i = 0; i < m.values.length; i += 1) peak = Math.max(peak, Math.abs(m.values[i]));
  });
  while (performance.now() - started < seconds * 1000) {
    await wait(5000);
    tick += 1;
    samples += 1;
    if (document.hidden) hiddenSamples += 1;
    h.sim.send('clap', { point: { x: 1 + (tick % 9), y: 1 + (tick % 5) } });
    if (tick % 2 === 0) {
      const door = h.room.objects.find((o) => o.type === 'door');
      h.commit(updateObject(h.room, door.id, { open: door.open > 0.5 ? 0 : 1 }), { undoable: false });
    }
    if (tick % 3 === 0) h.openWorkspace(spaces[tick % spaces.length]);
    if (tick % 5 === 0) {
      if (extraId) {
        h.commit(removeObjects(h.room, [extraId]), { undoable: false });
        extraId = null;
      } else {
        h.commit(addObject(h.room, { type: 'rect', x: 9, y: 2, w: 1, h: 1, material: 'foam' }), { undoable: false });
        extraId = h.room.objects[h.room.objects.length - 1].id;
      }
    }
    if (tick % 6 === 0) {
      const { stats } = await h.sim.request('stats');
      const now = performance.now();
      const dt = (now - lastAt) / 1000;
      const audioSeconds = audio.currentTime - lastAudio;
      rows.push({
        minute: +((now - started) / 60000).toFixed(1),
        realtime: +((stats.steps - last.steps) / dt / stats.rate).toFixed(3),
        // The browser's own audio clock, per second of wall time. The solver follows this.
        audioClock: +(audioSeconds / dt).toFixed(3),
        solverSeconds: (stats.steps - last.steps) / stats.rate,
        audioSeconds,
        rateChanged: stats.rate !== last.rate,
        rate: stats.rate,
        dropouts: stats.underruns - last.underruns,
        batchMs: +stats.batchMs.toFixed(1),
        hidden: hiddenSamples / samples,
        errors: stats.errors,
      });
      hiddenSamples = 0;
      samples = 0;
      last = stats;
      lastAt = now;
      lastAudio = audio.currentTime;
      window.hollowSoakProgress = rows[rows.length - 1];
    }
  }
  offPeak();
  hum.stop();
  await keepAwake.close();
  h.openWorkspace('listen');
  await h.sim.request('stats');
  // A rate change restarts the clocks, so the row it happened in can't be compared.
  const steady = rows.filter((r) => !r.rateChanged);
  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
  const mean = (list, key) => (list.length ? sum(list, key) / list.length : 0);
  const visible = steady.filter((r) => r.hidden === 0);
  const drift = Math.abs(sum(steady, 'solverSeconds') - sum(steady, 'audioSeconds')) / Math.max(1e-9, sum(steady, 'audioSeconds'));
  const dropouts = rows.reduce((s, r) => s + Math.max(0, r.dropouts), 0);
  const hiddenShare = mean(rows, 'hidden');
  const healthy = errs.length === 0 && Number.isFinite(peak) && peak < 50;
  const measured = `${(seconds / 60).toFixed(0)} min: solver vs audio clock ${(drift * 100).toFixed(2)}% apart; ${errs.length} errors; loudest ear value ${peak.toFixed(3)}. Reported, not judged: ${mean(steady, 'realtime').toFixed(3)}x real time (${visible.length ? `${mean(visible, 'realtime').toFixed(3)}x in ${visible.length} rows fully visible` : 'never fully visible'}), audio clock ${mean(steady, 'audioClock').toFixed(3)}x, page hidden ${(hiddenShare * 100).toFixed(0)}% of the time; ${dropouts} dropouts; final rate ${rows[rows.length - 1]?.rate}; ${rateChanges.length} rate changes`;
  const report = {
    when: new Date().toISOString(),
    results: [{
      id: 'soak',
      label: 'Everything running at once for 30 minutes: clock, stability, errors',
      target: 'solver within 1% of the audio clock; no errors; no instability',
      measured,
      pass: healthy && drift < 0.01,
      detail: { rows, rateChanges, drift, dropouts, errs: errs.slice(0, 10) },
    }],
  };
  // Short diagnostic runs don't replace the record of the full-length one.
  if (seconds >= 1800) await fetch('/__audit/soak', { method: 'POST', body: JSON.stringify(report) });
  h.output.setGain(h.volume);
  window.hollowSoakReport = report;
})().catch((error) => {
  window.hollowSoakReport = { failed: error.message, stack: error.stack };
});
