// Audio path audit. Needs a click, because browsers only start audio after a user gesture.

import { createAudioOutput } from '../audio/output.js';
import { peakFrequency, rms, spectrum } from '../audio/analysis.js';

const RATE = 16000;
const log = document.getElementById('log');
const button = document.getElementById('run-audio');

function write(line) {
  log.textContent += `${line}\n`;
}

function outcome(id, label, target, measured, pass, detail = {}) {
  return { id, label, target, measured, pass, detail };
}

let nextId = 1;
const waiting = new Map();
const worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (event) => {
  const { id, ok, result, error } = event.data;
  const entry = waiting.get(id);
  waiting.delete(id);
  if (ok) entry.resolve(result);
  else entry.reject(new Error(error));
};

function call(type, payload = {}, transfer = []) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

let output = null;

async function ensureRunning(gain = 0.08) {
  if (output) return;
  const channel = new MessageChannel();
  output = await createAudioOutput(channel.port1, { gain });
  await output.resume();
  await call('init', { port: channel.port2 }, [channel.port2]);
  await new Promise((r) => { setTimeout(r, 500); });
}

// A long, silent run: output gain zero, so it can run for half an hour without bothering
// anybody, while the audio thread still consumes samples exactly as it normally would.
export async function runSoak({ seconds = 1800 } = {}) {
  await ensureRunning(0);
  const soak = await call('soak', { seconds });
  const steps = soak.end.steps - soak.start.steps;
  const expected = soak.elapsed * RATE;
  const drift = Math.abs(steps - expected) / expected;
  const underruns = soak.end.underruns - soak.start.underruns;
  const ahead = soak.end.steps - soak.end.consumed;
  const report = {
    when: new Date().toISOString(),
    results: [outcome(
      'soak',
      `Solver steps vs audio samples over ${(seconds / 60).toFixed(0)} minutes`,
      'no drift',
      `${steps} steps against ${Math.round(expected)} expected (${(drift * 100).toFixed(3)}%); ${ahead} steps ahead of audio at the end; ${underruns} dropouts; ${soak.end.errors} errors`,
      ahead < soak.end.targetSeconds * RATE * 1.5 && soak.end.errors === 0,
      { soak, drift, underruns, ahead },
    )],
  };
  await fetch('/__audit/soak', { method: 'POST', body: JSON.stringify(report) });
  window.hollowSoakReport = report;
  return report;
}

export async function runAudioAudit({ soakSeconds = 20, save = true } = {}) {
  await ensureRunning();
  const results = [];

  const latency = await call('latency', { count: 8 });
  const device = output.outputLatency() * 1000;
  const sorted = [...latency.rows].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] + device;
  const worst = sorted[sorted.length - 1] + device;
  results.push(outcome(
    'clap-latency',
    'Clap to speaker latency',
    'under 100 ms',
    `median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms (includes ${device.toFixed(1)} ms device latency)`,
    median < 100,
    { rows: latency.rows, device },
  ));

  const frequency = 440;
  const tone = await call('tone', { frequency, seconds: 3, amplitude: 0.05 });
  const tapCount = 2;
  const frames = tone.samples.length / tapCount;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let n = 0; n < frames; n += 1) {
    left[n] = tone.samples[n * tapCount];
    right[n] = tone.samples[n * tapCount + 1];
  }
  const settled = Math.min(RATE, Math.floor(frames / 3));
  const measured = peakFrequency(
    spectrum(left.subarray(settled), RATE, { padTo: 65536 }),
    frequency * 0.8,
    frequency * 1.2,
  ).frequency;
  const pitchError = Math.abs(measured - frequency) / frequency;
  results.push(outcome(
    'ear-tone',
    'A 440 Hz source arrives at the ear at 440 Hz',
    'within 0.1%',
    `${measured.toFixed(2)} Hz; left ${rms(left, settled).toExponential(2)}, right ${rms(right, settled).toExponential(2)} rms`,
    pitchError < 0.001,
    { measured },
  ));

  const soak = await call('soak', { seconds: soakSeconds });
  const steps = soak.end.steps - soak.start.steps;
  const expected = soak.elapsed * RATE;
  const rateError = Math.abs(steps - expected) / expected;
  const underruns = soak.end.underruns - soak.start.underruns;
  const lag = soak.end.steps - soak.end.consumed;
  results.push(outcome(
    'audio-sync',
    `Solver steps vs audio samples over ${soakSeconds} s`,
    'no drift, no underruns',
    `${steps} steps against ${Math.round(expected)} expected (${(rateError * 100).toFixed(3)}%); ${underruns} underruns, ${lag} steps ahead of audio at the end, buffer target ${(soak.end.targetSeconds * 1000).toFixed(0)} ms`,
    underruns === 0 && lag < soak.end.targetSeconds * RATE * 1.5 && rateError < 0.01,
    { soak, underruns, lag, errors: soak.end.errors, dropped: soak.end.dropped },
  ));

  for (const r of results) {
    write(`${r.pass ? 'PASS' : 'MISS'}  ${r.label}\n      target ${r.target}\n      measured ${r.measured}`);
  }
  const report = { when: new Date().toISOString(), results };
  if (save) await fetch('/__audit/audio', { method: 'POST', body: JSON.stringify(report) });
  window.hollowAudioReport = report;
  return report;
}

button.addEventListener('click', () => {
  button.disabled = true;
  write('running audio audit...');
  runAudioAudit().catch((error) => {
    write(`FAILED: ${error.message}`);
    window.hollowAudioReport = { error: error.message };
  }).finally(() => {
    button.disabled = false;
  });
});

window.hollowAudioAudit = runAudioAudit;
window.hollowSoak = runSoak;
window.hollowAudioCall = (type, payload) => ensureRunning().then(() => call(type, payload));
