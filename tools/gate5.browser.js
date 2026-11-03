// Browser checks for the last untested behaviour, in the running app: Compare, performance
// history, share links, Fly past, Blow, the microphone with injected samples, audio files, and
// every control on every panel. Downloads and file pickers are intercepted, so nothing is saved.
(async () => {
  const h = window.hollow;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !h.active; i += 1) await wait(250);
  await wait(400);
  // An off-screen pane never runs animation frames. Door swings and fly-pasts need them, so here
  // they run on a timer instead. This changes the test's page, not the app's code.
  const frames = await new Promise((resolve) => {
    let n = 0;
    const count = () => { n += 1; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    setTimeout(() => resolve(n), 300);
  });
  if (frames === 0) window.requestAnimationFrame = (run) => setTimeout(() => run(performance.now()), 16);
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  window.addEventListener('error', (e) => errs.push(`${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno} ${e.error?.stack?.split('\n').slice(1, 4).join(' | ') ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => errs.push(String(e.reason?.message ?? e.reason)));
  await h.ensureAudio();
  h.output.setGain(0.00005);
  const { makeScene } = await import('/src/scene/presets.js');
  const { addObject } = await import('/src/scene/room.js');
  const { roomLink, decodeRoom, roomFromHash } = await import('/src/scene/sharelink.js');
  const { encodeWav } = await import('/src/audio/wav.js');
  const out = {};
  const section = async (name, run) => {
    try {
      out[name] = await run();
    } catch (error) {
      out[name] = { failed: error.message };
    }
  };
  const panelButton = (text) => [...h.dom.panel.querySelectorAll('button')].find((b) => b.textContent === text);
  const record = async (ms) => {
    const left = [];
    const off = h.addSampleListener((m) => {
      for (let i = 0; i < m.count; i += 1) left.push(m.values[i * m.taps]);
    });
    await wait(ms);
    off();
    return Float32Array.from(left);
  };
  const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / Math.max(1, v.length));
  // Autocorrelation peak: the pitch of a steady signal, without assuming one.
  const pitch = (v, rate, low = 50, high = 2500) => {
    const size = Math.min(v.length, 8192);
    const correlate = (lag) => {
      let sum = 0;
      for (let i = 0; i + lag < size; i += 1) sum += v[i] * v[i + lag];
      return sum;
    };
    // Short lags always correlate, so the search starts past the first dip below zero.
    let lag = Math.max(1, Math.floor(rate / high));
    const limit = Math.min(size / 2, rate / low);
    while (lag < limit && correlate(lag) > 0) lag += 1;
    let best = 0;
    let bestLag = 0;
    for (; lag < limit; lag += 1) {
      const sum = correlate(lag);
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    return bestLag ? rate / bestLag : null;
  };

  // Comparison: identical rooms show no difference, and moving one wall shows one.
  await section('compare', async () => {
    const base = addObject(makeScene('dead-room'), { type: 'wall', points: [{ x: 2, y: 1 }, { x: 2, y: 3 }], thickness: 0.2, material: 'stone' });
    await h.loadRoom(base);
    h.openWorkspace('lab');
    await wait(400);
    const lab = h.active;
    const moved = { ...h.room, objects: h.room.objects.map((o, n) => (n === h.room.objects.length - 1 ? { ...o, points: o.points.map((p) => ({ x: p.x + 1.5, y: p.y })) } : o)) };
    const entry = { id: 'gate5-compare', name: 'Gate 5 moved wall', room: moved };
    await h.storage.put('rooms', entry);
    h.renderPanel();
    await wait(400);
    // The first select offering these versions is A, the second is B.
    const pick = (value) => {
      const [versionA, versionB] = [...h.dom.panel.querySelectorAll('select')].filter((s) => [...s.options].some((o) => o.value === 'current'));
      versionA.value = 'current';
      versionB.value = value;
    };
    const runCompare = async () => {
      h.dom.panel.querySelectorAll('dl.metrics').forEach((n) => n.remove());
      panelButton('Compare').click();
      for (let i = 0; i < 400 && !h.dom.panel.querySelector('dl.metrics'); i += 1) await wait(200);
      return lab.lastDifference;
    };
    pick('current');
    const identical = await runCompare();
    pick(`saved:${entry.id}`);
    const movedWall = await runCompare();
    const hearing = !!panelButton('Hear A') && !!panelButton('Hear B');
    await h.storage.delete('rooms', entry.id);
    return { identical, movedWall, hearing, pass: identical < 0.01 && movedWall > 0.5 };
  });

  // Performance history against the solver's and worklet's own counters, under real overload.
  await section('perfHistory', async () => {
    await h.loadRoom(makeScene('cathedral'));
    h.openWorkspace('perf');
    await wait(300);
    const { history } = h.active;
    const reply = await h.sim.request('setRate', { rate: 22050 });
    h.rate = reply.rate;
    h.gridChanged(reply);
    await wait(4000);
    const started = (await h.sim.request('stats')).stats;
    const samplesBefore = history.samples.length;
    const audio = h.output.context;
    const audioStart = audio.currentTime;
    await wait(20000);
    const ended = (await h.sim.request('stats')).stats;
    const audioSeconds = audio.currentTime - audioStart;
    const logged = history.samples.slice(samplesBefore).reduce((s, x) => s + x.underrunsAdded, 0);
    const exported = JSON.parse(JSON.stringify(history.export()));
    const restored = await h.sim.request('remeasure');
    h.rate = restored.rate;
    h.gridChanged(restored);
    return {
      underrunsByWorklet: ended.underruns - started.underruns,
      underrunsLogged: logged,
      audioSeconds: +audioSeconds.toFixed(2),
      solverSeconds: +((ended.steps - started.steps) / 22050).toFixed(2),
      fps: ended.fps,
      timing: ended.timing,
      gpuMs: ended.gpuMs,
      exportedSamples: exported.samples.length,
      exportedNote: exported.note.slice(0, 40),
    };
  });

  // Share link: the link is the room, and a damaged link is refused.
  await section('shareLink', async () => {
    const room = addObject(makeScene('flutter-corridor'), { type: 'rect', x: 2, y: 1, w: 1, h: 1, material: 'foam' });
    const { link } = await roomLink(room, 'http://localhost:8791/');
    const encoded = roomFromHash(new URL(link).hash);
    const decoded = await decodeRoom(encoded);
    const damaged = await decodeRoom(`${encoded.slice(0, encoded.length / 2)}xx${encoded.slice(encoded.length / 2 + 2)}`);
    window.hollowGate5Link = link;
    // Links round numbers to a millimetre, so "the same room" means the same grid for the solver.
    const { rasterise } = await import('/src/scene/rasterise.js');
    const gridOf = (r) => rasterise(r, 16000).grid;
    const a = gridOf(room);
    const b = gridOf(decoded.room);
    let cellsDiffering = a.length === b.length ? 0 : Infinity;
    for (let i = 0; i < a.length && i < b.length; i += 1) if (a[i] !== b[i]) cellsDiffering += 1;
    return {
      length: link.length,
      cellsDiffering,
      sameName: decoded.room?.name === room.name,
      damagedRefused: damaged.ok === false,
      damagedMessage: damaged.error?.slice(0, 80),
    };
  });

  // Fly past: only the speaker moves, and the pitch falls as it passes.
  await section('flyPast', async () => {
    await h.loadRoom(makeScene('flyby'));
    h.openWorkspace('sources');
    await wait(300);
    const start = { x: 1, y: h.room.ear.y };
    h.commit({ ...h.room, speakers: [{ id: 'fly', name: 'Speaker 1', x: start.x, y: start.y, signal: 'tone', frequency: 700, phase: 0, delay: 0, gain: 0.25, on: true }] });
    h.renderPanel();
    panelButton('Speaker 1').click();
    await wait(1500);
    const positions = [];
    const track = setInterval(() => positions.push(h.room.speakers[0].x), 16);
    const recording = record(1400);
    await wait(150);
    panelButton('Fly past me').click();
    const trace = await recording;
    clearInterval(track);
    const minX = Math.min(...positions);
    const maxX = Math.max(...positions);
    const section5 = (a, b) => trace.subarray(Math.floor(trace.length * a), Math.floor(trace.length * b));
    const reply = { rate: h.rate };
    const end = h.room.speakers[0];
    const windows = [];
    for (let at = 0; at + 0.1 < 1; at += 0.1) windows.push(+((pitch(section5(at, at + 0.1), reply.rate, 300, 1500)) ?? 0).toFixed(0));
    h.commit({ ...h.room, speakers: [] });
    return { minX, maxX, returnedTo: end.x, startedAt: start.x, windowsHz: windows };
  });

  // Blow: holding the real button makes the pipe sound, and letting go stops it.
  await section('blow', async () => {
    await h.loadRoom(makeScene('organ-pipe'));
    h.openWorkspace('listen');
    await wait(1200);
    const quiet = rms(await record(500));
    const held = panelButton('Hold to blow');
    held.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(2000);
    const sounding = await record(1000);
    held.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(2500);
    const after = rms(await record(500));
    return { quiet, sounding: rms(sounding), pitchHz: pitch(sounding, h.rate), after };
  });

  // Microphone: injected samples, not a real voice. They reach the ears and the tracks stop.
  await section('microphone', async () => {
    await h.loadRoom(makeScene('dead-room'));
    h.openWorkspace('studio');
    await wait(300);
    panelButton('I am wearing headphones').click();
    await wait(100);
    const { context } = h.output;
    const osc = context.createOscillator();
    osc.frequency.value = 440;
    const dest = context.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const original = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    const quiet = rms(await record(400));
    const hold = panelButton('Hold to talk');
    hold.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(1500);
    const talking = await record(1000);
    window.dispatchEvent(new PointerEvent('pointerup'));
    await wait(1500);
    const after = rms(await record(400));
    const tracks = dest.stream.getTracks().map((t) => t.readyState);
    navigator.mediaDevices.getUserMedia = original;
    osc.stop();
    return { quiet, talking: rms(talking), pitchHz: pitch(talking, h.rate), after, tracks };
  });

  // An audio file: decoded, played inside the room, and refused if it isn't audio.
  await section('audioFile', async () => {
    h.openWorkspace('studio');
    await wait(300);
    const rate = 44100;
    const tone = new Float32Array(rate);
    for (let i = 0; i < tone.length; i += 1) tone[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / rate);
    const wav = encodeWav([tone, tone], rate, { bits: 32 });
    const input = h.dom.panel.querySelector('input[type=file]');
    const send = (file) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    send(new File([wav], 'gate5-tone.wav', { type: 'audio/wav' }));
    await wait(1500);
    const playingToast = h.dom.toast.textContent;
    const playing = await record(1000);
    const panelInput = h.dom.panel.querySelector('input[type=file]');
    const stop = [...h.dom.panel.querySelectorAll('button')].find((b) => /stop/i.test(b.textContent));
    stop?.click();
    await wait(800);
    panelInput?.isConnected;
    const badInput = h.dom.panel.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(64)], 'not-audio.wav', { type: 'audio/wav' }));
    badInput.files = transfer.files;
    badInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(400);
    return { playingToast, level: rms(playing), pitchHz: pitch(playing, h.rate), stopFound: !!stop, refusedToast: h.dom.toast.textContent };
  });

  // Every control on every panel: pressed, moved, chosen. Mostly looking for anything that throws.
  await section('everyControl', async () => {
    const realClick = HTMLAnchorElement.prototype.click;
    const realInputClick = HTMLInputElement.prototype.click;
    const realConfirm = window.confirm;
    const realGum = navigator.mediaDevices.getUserMedia;
    let intercepted = 0;
    HTMLAnchorElement.prototype.click = function click() { intercepted += 1; };
    HTMLInputElement.prototype.click = function click() { if (this.type !== 'file') realInputClick.call(this); else intercepted += 1; };
    window.confirm = () => true;
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('blocked for the test', 'NotAllowedError'); };
    const report = [];
    const seen = new WeakSet();
    const spaces = h.workspaces.map((w) => w.key);
    for (const key of spaces) {
      await h.loadRoom(makeScene('cathedral'));
      h.openWorkspace(key);
      await wait(300);
      const before = errs.length;
      let pressed = 0;
      let moved = 0;
      let chosen = 0;
      // The panel rebuilds itself, so controls are found again by position after each use.
      const total = h.dom.panel.querySelectorAll('button, input[type=range], select, input[type=checkbox]').length;
      for (let n = 0; n < total + 12; n += 1) {
        const controls = [...h.dom.panel.querySelectorAll('button, input[type=range], select, input[type=checkbox]')];
        const control = controls[n];
        if (!control) break;
        if (seen.has(control) || control.disabled) continue;
        seen.add(control);
        if (control.tagName === 'BUTTON') {
          control.click();
          pressed += 1;
        } else if (control.tagName === 'SELECT') {
          const choices = [...control.options].map((o) => o.value);
          const next = choices[Math.min(1, choices.length - 1)];
          // Skip the room switcher's choice of an expensive rate here: rates have their own check.
          control.value = next;
          control.dispatchEvent(new Event('change', { bubbles: true }));
          chosen += 1;
        } else if (control.type === 'checkbox') {
          control.click();
          moved += 1;
        } else {
          const lo = Number(control.min);
          const hi = Number(control.max);
          control.value = lo + (hi - lo) * 0.6;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
          moved += 1;
        }
        await wait(60);
        document.querySelectorAll('dialog[open]').forEach((d) => d.close());
        // A control may have opened another workspace or room. Come back.
        if (h.active.key !== key) {
          h.openWorkspace(key);
          await wait(100);
        }
      }
      report.push({ key, total, pressed, moved, chosen, newErrors: errs.slice(before).slice(0, 3) });
      await h.sim.request('timeLive').catch(() => {});
      await wait(200);
    }
    HTMLAnchorElement.prototype.click = realClick;
    HTMLInputElement.prototype.click = realInputClick;
    window.confirm = realConfirm;
    navigator.mediaDevices.getUserMedia = realGum;
    const { stats } = await h.sim.request('stats');
    const auto = await h.sim.request('remeasure');
    h.rate = auto.rate;
    h.gridChanged(auto);
    return { intercepted, report, stepsStillRunning: stats.steps, rate: stats.rate };
  });

  out.errs = errs.slice(0, 10);
  h.output.setGain(h.volume);
  window.hollowGate5 = out;
})().catch((error) => {
  window.hollowGate5 = { failed: error.message, stack: error.stack };
});
