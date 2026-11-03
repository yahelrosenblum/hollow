// Runs browser gates 2 to 5 one after another in the running app and collects their reports on
// window.hollowGates. A hum keeps a hidden page's audio awake (see DECISIONS.md); it's 30 Hz at
// -60 dBFS, in its own audio context, and stops at the end.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 400 && !window.hollow?.active; i += 1) await wait(250);
  await window.hollow.dismissWelcome?.();
  const keepAwake = new AudioContext();
  const hum = keepAwake.createOscillator();
  const level = keepAwake.createGain();
  hum.frequency.value = 30;
  level.gain.value = 0.001;
  hum.connect(level).connect(keepAwake.destination);
  hum.start();
  await keepAwake.resume();
  const results = {};
  window.hollowGates = { running: 'starting', results };
  for (const [name, global] of [['gate2', 'hollowGate2'], ['gate3', 'hollowGate3'], ['gate4', 'hollowGate4'], ['gate5', 'hollowGate5']]) {
    window.hollowGates.running = name;
    window[global] = undefined;
    const started = performance.now();
    const script = document.createElement('script');
    script.src = `/tools/${name}.browser.js?${Date.now()}`;
    document.head.append(script);
    for (let i = 0; i < 2400 && window[global] === undefined; i += 1) await wait(250);
    results[name] = { seconds: Math.round((performance.now() - started) / 1000), report: window[global] ?? 'timed out' };
    await window.hollow.sim.request('timeLive').catch(() => {});
    await window.hollow.loadRoom((await import('/src/scene/presets.js')).makeScene('cathedral'));
    await wait(500);
  }
  hum.stop();
  await keepAwake.close();
  window.hollowGates.running = 'done';
})().catch((error) => {
  window.hollowGates = { failed: error.message, stack: error.stack };
});
