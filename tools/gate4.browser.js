// Browser checks for the code review's fixes and the keyboard-only path, in the running app.
(async () => {
  const h = window.hollow;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !h.active; i += 1) await wait(250);
  await wait(400);
  // An off-screen pane never runs animation frames, and door swings need them. Here they run
  // on a timer instead. This changes the test's page, not the app's code.
  const frames = await new Promise((resolve) => {
    let n = 0;
    const count = () => { n += 1; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    setTimeout(() => resolve(n), 300);
  });
  if (frames === 0) window.requestAnimationFrame = (run) => setTimeout(() => run(performance.now()), 16);
  const errs = [];
  h.sim.on('gpu-error', (m) => errs.push(m.message));
  window.addEventListener('error', (e) => errs.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push(String(e.reason?.message ?? e.reason)));
  await h.ensureAudio();
  h.output.setGain(0);
  const { makeScene } = await import('/src/scene/presets.js');
  const { addObject } = await import('/src/scene/room.js');
  const out = {};
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const overlay = h.dom.overlay;

  // 1. The thickness slider survives being dragged.
  await h.loadRoom(makeScene('cathedral'));
  h.openWorkspace('build');
  await wait(200);
  const space = h.active;
  space.chooseTool('select');
  const firstWall = addObject(h.room, { type: 'wall', points: [{ x: 3, y: 1 }, { x: 5, y: 1 }], thickness: 0.2, material: 'stone' });
  h.commit(firstWall);
  const wallId = h.room.objects[h.room.objects.length - 1].id;
  space.build.select(wallId);
  await wait(100);
  // The last one: the first belongs to "New objects", the last to the selected object.
  const slider = [...h.dom.panel.querySelectorAll('input[type=range]')].filter((n) => n.getAttribute('aria-label') === 'Thickness').pop();
  slider.value = 0.5;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  slider.value = 0.6;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  out.slider = {
    stillInPage: slider.isConnected,
    thickness: h.room.objects.find((o) => o.id === wallId).thickness,
  };

  // 2. A door button still rebuilds its label.
  const doorRoom = addObject(h.room, {
    type: 'door', hinge: { x: 8, y: 3 }, length: 1, angle: Math.PI / 2, swing: Math.PI / 2, open: 0, thickness: 0.08, frame: 0.3, material: 'wood',
  });
  h.commit(doorRoom);
  space.build.select(doorRoom.objects[doorRoom.objects.length - 1].id);
  await wait(100);
  const doorButton = [...h.dom.panel.querySelectorAll('button')].find((b) => b.textContent === 'Open the door');
  doorButton.click();
  for (let i = 0; i < 40 && h.room.objects.find((o) => o.type === 'door').open !== 1; i += 1) await wait(100);
  await wait(100);
  out.door = {
    open: h.room.objects.find((o) => o.type === 'door').open,
    label: [...h.dom.panel.querySelectorAll('button')].some((b) => b.textContent === 'Shut the door'),
  };

  // 3. Shortcuts, typed for real.
  // The room itself, not a count: the last change may be the door swinging, not an object.
  const snapshot = () => JSON.stringify(h.room.objects);
  const original = snapshot();
  key(document.body, { key: 'z', ctrlKey: true });
  const undone = snapshot();
  key(document.body, { key: 'Z', ctrlKey: true, shiftKey: true });
  const redone = snapshot();
  const before = original.length;
  const afterUndo = undone !== original ? 'changed' : 'unchanged';
  const afterRedo = redone === original ? 'restored' : 'different';
  key(document.body, { key: 'w' });
  const toolAfterW = space.build.toolKey;
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  key(input, { key: 'e' });
  const toolWhileTyping = space.build.toolKey;
  input.remove();
  key(document.body, { key: '0' });
  const tenthKey = h.active.key;
  out.shortcuts = {
    before, afterUndo, afterRedo, toolAfterW, toolWhileTyping, tenthKey,
  };

  // 4. A wall drawn with only the keyboard, on the real canvas.
  h.openWorkspace('build');
  await wait(100);
  h.active.chooseTool('wall');
  overlay.focus();
  const count = h.room.objects.length;
  key(overlay, { key: 'Enter' });
  for (let i = 0; i < 12; i += 1) key(overlay, { key: 'ArrowRight' });
  key(overlay, { key: 'Enter' });
  for (let i = 0; i < 10; i += 1) key(overlay, { key: 'ArrowDown' });
  key(overlay, { key: 'Enter' });
  key(overlay, { key: 'Enter', shiftKey: true });
  await wait(100);
  const drawn = h.room.objects[h.room.objects.length - 1];
  out.keyboardWall = { added: h.room.objects.length - count, points: drawn.points?.length };

  // 5. Clap from the keyboard.
  h.openWorkspace('listen');
  await wait(100);
  overlay.focus();
  const clapAt = h.lastClap;
  for (let i = 0; i < 5; i += 1) key(overlay, { key: 'ArrowLeft', shiftKey: true });
  key(overlay, { key: 'Enter' });
  out.keyboardClap = { moved: h.lastClap !== clapAt, at: h.lastClap };

  // 6. Changing a room setting keeps sound playing; changing rate says it stopped.
  await h.loadRoom(makeScene('cathedral'));
  h.openWorkspace('spectrum');
  await wait(200);
  const spectrum = h.active;
  spectrum.setFrequency(300, { play: true });
  await wait(600);
  const earLevel = async () => {
    let sum = 0;
    let n = 0;
    const off = h.addSampleListener((m) => {
      for (let i = 0; i < m.count; i += 1) {
        sum += m.values[i * m.taps] ** 2;
        n += 1;
      }
    });
    await wait(500);
    off();
    return Math.sqrt(sum / (n || 1));
  };
  const toneBefore = await earLevel();
  h.commit({ ...h.room, edges: 'open' });
  h.refreshSizeSoon();
  await wait(1000);
  const toneAfterEdit = await earLevel();
  const buttonText = () => [...h.dom.panel.querySelectorAll('button')].find((b) => /tone/i.test(b.textContent))?.textContent;
  const labelWhilePlaying = buttonText();
  const rate = h.rate === 8000 ? 11025 : 8000;
  const reply = await h.sim.request('setRate', { rate });
  h.rate = reply.rate;
  h.gridChanged(reply);
  await wait(500);
  out.voices = {
    toneBefore, toneAfterEdit, labelWhilePlaying, labelAfterRateChange: buttonText(),
  };

  // 7. The probe stays on the same spot in the room when the grid changes.
  h.openWorkspace('xray');
  await wait(300);
  const xray = h.active;
  const spot = { x: 5, y: 3 };
  xray.place(spot);
  await wait(300);
  const auto = await h.sim.request('remeasure');
  h.rate = auto.rate;
  h.gridChanged(auto);
  await wait(500);
  const { stats } = await h.sim.request('stats');
  out.probe = {
    rate: stats.rate, point: xray.point, probeRate: xray.probe?.rate, readingFinite: Number.isFinite(xray.probe?.read().rms ?? NaN),
  };

  // 8. Concurrent bakes don't mix: two different rooms, asked for at the same moment.
  const simple = (width) => ({ ...makeScene('dead-room'), width });
  const stimulus = { kind: 'impulse' };
  const bakeOf = (room) => h.sim.request('bake', {
    room, sources: [{ point: { x: 1, y: 1 }, stimulus }], listeners: [{ x: 3, y: 2 }], seconds: 0.2, rate: 8000,
  });
  const [a1, b1] = await Promise.all([bakeOf(simple(8)), bakeOf(simple(5))]);
  const a2 = await bakeOf(simple(8));
  let difference = 0;
  for (let i = 0; i < a1.traces[0].length; i += 1) difference = Math.max(difference, Math.abs(a1.traces[0][i] - a2.traces[0][i]));
  let different = 0;
  for (let i = 0; i < a1.traces[0].length; i += 1) different = Math.max(different, Math.abs(a1.traces[0][i] - b1.traces[0][i]));
  out.bakes = { repeatDifference: difference, otherRoomDifference: different };

  // 9. Time state resets cleanly when a different room loads during a playback.
  await h.loadRoom(makeScene('cathedral'));
  h.openWorkspace('time');
  await wait(200);
  await h.sim.request('timeRecord');
  h.sim.send('clap', { point: { x: 6, y: 4 } });
  await wait(600);
  await h.sim.request('timePlayback', { speed: 0.5 });
  await wait(200);
  const inPlayback = h.active.timeState?.kind;
  await h.loadRoom(makeScene('cave'));
  await wait(300);
  const refused = await h.sim.request('timePlayback', { speed: 0.5 });
  out.time = { inPlayback, kindAfterLoad: h.active.timeState?.kind, badge: h.dom.timeBadge.hidden ? null : h.dom.timeBadge.textContent, oldRecordingRefused: refused };
  await h.sim.request('timeLive');

  out.errs = errs.slice(0, 5);
  out.toast = h.dom.toast.textContent;
  h.output.setGain(h.volume);
  window.hollowGate4 = out;
})().catch((error) => {
  window.hollowGate4 = { failed: error.message, stack: error.stack };
});
