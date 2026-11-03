import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DcBlocker, EarChain, GRID_CUTOFF, GridCutoffFilter, HalfOrderFilter, SafetyLimiter,
} from '../src/audio/chain.js';
import {
  RESAMPLER_TAPS, StreamResampler, createResampleTable, interpolate,
} from '../src/audio/resampler.js';
import {
  BreathSource, ClapSource, Differentiator, ImpulseSource, NoiseSource, SourceFilter, ToneSource, renderTone,
} from '../src/audio/sources.js';
import { decayTime, peakFrequency, spectrum } from '../src/audio/analysis.js';

const RATE = 16000;

function toneLevel(filter, frequency, seconds = 1) {
  const n = Math.floor(RATE * seconds);
  let power = 0;
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const out = filter.process(Math.sin((2 * Math.PI * frequency * i) / RATE));
    if (i > n / 2) {
      power += out * out;
      count += 1;
    }
  }
  return 10 * Math.log10((2 * power) / count);
}

test('half-order filter falls 3 dB per octave across the band', () => {
  const levels = [62.5, 125, 250, 500, 1000, 2000, 4000].map((f) => toneLevel(new HalfOrderFilter(RATE), f, 2));
  for (let i = 1; i < levels.length; i += 1) {
    const slope = levels[i] - levels[i - 1];
    assert.ok(Math.abs(slope + 3.01) < 1, `octave ${i} slope ${slope}`);
  }
});

test('half-order filter is unity at 1 kHz', () => {
  assert.ok(Math.abs(toneLevel(new HalfOrderFilter(RATE), 1000, 2)) < 0.1);
});

test('DC blocker removes a constant', () => {
  const dc = new DcBlocker(RATE);
  let out = 1;
  for (let i = 0; i < RATE * 2; i += 1) out = dc.process(0.5);
  assert.ok(Math.abs(out) < 1e-3);
});

test('ear chain survives a large DC offset', () => {
  const chain = new EarChain(RATE);
  let out = 0;
  for (let i = 0; i < RATE * 3; i += 1) out = chain.process(0.2);
  assert.ok(Math.abs(out) < 1e-2);
});

test('the band-edge filter removes the grid cutoff and leaves the usable band alone', () => {
  const measure = (cycles) => {
    const filter = new GridCutoffFilter();
    let power = 0;
    let count = 0;
    for (let i = 0; i < 16000; i += 1) {
      const out = filter.process(Math.sin(2 * Math.PI * cycles * i));
      if (i > 8000) {
        power += out * out;
        count += 1;
      }
    }
    return 10 * Math.log10((2 * power) / count);
  };
  assert.ok(Math.abs(GRID_CUTOFF - 0.3295) < 0.001, `cutoff ${GRID_CUTOFF}`);
  assert.ok(measure(GRID_CUTOFF) < -40, `at the cutoff: ${measure(GRID_CUTOFF)} dB`);
  assert.ok(Math.abs(measure(0.05)) < 0.2, `in band: ${measure(0.05)} dB`);
  assert.ok(measure(0.2) > -1.5, `near the top of the band: ${measure(0.2)} dB`);
});

test('the source filter passes the band and stops what the grid would trap', () => {
  const gain = (cycles) => {
    const filter = new SourceFilter();
    const block = new Float32Array(2048);
    for (let i = 0; i < block.length; i += 1) block[i] = Math.sin(2 * Math.PI * cycles * i);
    filter.process(block, block.length);
    const expected = 2 * Math.sin(Math.PI * cycles); // the first difference it also applies
    let peak = 0;
    for (let i = 200; i < block.length; i += 1) peak = Math.max(peak, Math.abs(block[i]));
    return 20 * Math.log10(peak / expected + 1e-12);
  };
  assert.ok(Math.abs(gain(0.05)) < 0.2);
  assert.ok(gain(GRID_CUTOFF) < -40, `at the cutoff: ${gain(GRID_CUTOFF)} dB`);
});

test('limiter holds the ceiling and releases afterward', () => {
  const limiter = new SafetyLimiter(48000);
  let worst = 0;
  for (let i = 0; i < 1000; i += 1) {
    const sample = 3 * Math.sin(i * 0.05);
    worst = Math.max(worst, Math.abs(sample * limiter.gainFor(sample, sample)));
  }
  assert.ok(worst <= limiter.ceiling + 1e-9);
  for (let i = 0; i < 96000; i += 1) limiter.gainFor(0, 0);
  assert.ok(limiter.gain > 0.99);
});

test('limiter leaves quiet sound completely alone', () => {
  const limiter = new SafetyLimiter(48000);
  for (let i = 0; i < 1000; i += 1) assert.equal(limiter.gainFor(0.1, -0.1), 1);
});

function resampleInBlocks(frequency, inputRate, outputRate, seconds = 2) {
  const resampler = new StreamResampler(inputRate, outputRate);
  const parts = [];
  let at = 0;
  while (at < seconds * inputRate) {
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i += 1) block[i] = Math.sin((2 * Math.PI * frequency * (at + i)) / inputRate);
    at += 128;
    parts.push(resampler.process(block));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let filled = 0;
  for (const part of parts) {
    out.set(part, filled);
    filled += part.length;
  }
  return { out, consumed: at };
}

const rmsOf = (v, skip = 512) => Math.sqrt(v.subarray(skip).reduce((s, x) => s + x * x, 0) / (v.length - skip));

test('a live stream resamples to finite values, at any pair of rates', () => {
  // Regression: reading before the start of a block gave NaN, and the mic blew up the simulation.
  for (const [input, output] of [[48000, 8000], [48000, 11025], [48000, 16000], [48000, 22050], [44100, 16000], [16000, 22050], [8000, 22050]]) {
    const { out, consumed } = resampleInBlocks(300, input, output);
    assert.ok(out.every(Number.isFinite), `${input} to ${output} produced a non-finite value`);
    const expected = (consumed * output) / input;
    assert.ok(Math.abs(out.length - expected) <= 2, `${input} to ${output}: ${out.length} samples, expected ${expected}`);
  }
});

test('a live stream keeps its pitch and level across block boundaries', () => {
  const rate = 16000;
  const { out } = resampleInBlocks(500, 48000, rate);
  assert.ok(Math.abs(rmsOf(out) - Math.SQRT1_2) < 0.02, `level ${rmsOf(out)}`);
  const { frequency } = peakFrequency(spectrum(out.subarray(512), rate));
  assert.ok(Math.abs(frequency - 500) < 5, `pitch ${frequency}`);
  // A click at a block boundary would show as a jump far beyond what a 500 Hz sine can do.
  const biggestStep = out.subarray(512).reduce((m, v, i, a) => (i ? Math.max(m, Math.abs(v - a[i - 1])) : m), 0);
  assert.ok(biggestStep < (2 * Math.PI * 500) / rate * 1.1, `largest step ${biggestStep}`);
});

test('a live stream does not fold high sounds down into the band', () => {
  // 13 kHz would land on 3 kHz at a 16 kHz simulation, inside what the room can carry.
  const { out } = resampleInBlocks(13000, 48000, 16000);
  const db = 20 * Math.log10(rmsOf(out) / Math.SQRT1_2);
  assert.ok(db < -20, `13 kHz came through at ${db.toFixed(1)} dB`);
});

test('a breath reaches the room with its lows intact, at any rate', () => {
  // Regression: plain noise lost its lows to the source chain's difference, so at 16 and 22 kHz
  // a blown reed started on a high mode across the pipe instead of the pipe's own note.
  const bandRatioDb = (Source, rate) => {
    const source = new Source(rate, { amplitude: 1, rampSeconds: 0 });
    const chain = new SourceFilter();
    const signal = new Float32Array(rate * 2);
    source.render(signal, signal.length);
    chain.process(signal, signal.length);
    const { magnitude, binHz } = spectrum(signal.subarray(rate / 2), rate);
    const band = (lo, hi) => {
      let sum = 0;
      for (let k = Math.ceil(lo / binHz); k <= hi / binHz; k += 1) sum += magnitude[k] ** 2;
      return sum / ((hi - lo) / binHz);
    };
    return 10 * Math.log10(band(60, 250) / band(1500, 2500));
  };
  for (const rate of [8000, 16000, 22050]) {
    assert.ok(Math.abs(bandRatioDb(BreathSource, rate)) < 6, `breath at ${rate} Hz: lows vs highs ${bandRatioDb(BreathSource, rate).toFixed(1)} dB`);
    assert.ok(bandRatioDb(NoiseSource, rate) < -15, 'plain noise really does lose its lows');
  }
});

test('resampler keeps a tone at the right pitch and level', () => {
  const inputRate = 16000;
  const outputRate = 48000;
  const table = createResampleTable(inputRate, outputRate);
  const frequency = 1000;
  const input = new Float32Array(inputRate);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((2 * Math.PI * frequency * i) / inputRate);
  const count = 24000;
  const out = new Float64Array(count);
  const step = inputRate / outputRate;
  for (let n = 0; n < count; n += 1) {
    const position = 200 + n * step;
    const index = Math.floor(position);
    out[n] = interpolate(table, position - index, (k) => input[index + k]);
  }
  const measured = peakFrequency(spectrum(out, outputRate, { padTo: 131072 }), 500, 2000).frequency;
  assert.ok(Math.abs(measured - frequency) < 0.5);
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 1) < 0.01);
  assert.equal(RESAMPLER_TAPS % 2, 0);
});

test('a clap has no net displacement', () => {
  const clap = new ClapSource(RATE);
  const out = new Float32Array(clap.length + 10);
  clap.render(out, out.length);
  const sum = out.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum) < 1e-3);
  assert.ok(clap.done);
});

test('an impulse fires exactly once', () => {
  const impulse = new ImpulseSource(0.5);
  const a = new Float32Array(4);
  const b = new Float32Array(4);
  impulse.render(a, 4);
  impulse.render(b, 4);
  assert.deepEqual([...a], [0.5, 0, 0, 0]);
  assert.deepEqual([...b], [0, 0, 0, 0]);
});

test('tones ramp in rather than starting at full level', () => {
  const tone = new ToneSource(RATE, { frequency: 2000, amplitude: 1 });
  const out = new Float32Array(32);
  tone.render(out, 32);
  assert.ok(out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) < 0.2);
});

test('a stopped tone finishes', () => {
  const tone = new ToneSource(RATE, { frequency: 200, amplitude: 1, rampSeconds: 0.001 });
  const out = new Float32Array(200);
  tone.render(out, 200);
  tone.stop();
  tone.render(out, 200);
  assert.ok(tone.done);
});

test('tones with a set phase offset keep that offset, across block boundaries', () => {
  const rate = RATE;
  const a = new Float32Array(100);
  const b = new Float32Array(100);
  renderTone(a, 100, 5000, rate, { frequency: 440 });
  renderTone(b, 100, 5000, rate, { frequency: 440, phase: Math.PI });
  for (let i = 0; i < 100; i += 1) assert.ok(Math.abs(a[i] + b[i]) < 1e-5);
});

test('differentiator produces the first difference across blocks', () => {
  const diff = new Differentiator();
  const a = Float32Array.from([1, 3]);
  const b = Float32Array.from([6]);
  diff.process(a, 2);
  diff.process(b, 1);
  assert.deepEqual([...a], [1, 2]);
  assert.deepEqual([...b], [3]);
});

test('decayTime recovers a known exponential decay', () => {
  const rt60 = 1.2;
  const n = RATE * 3;
  const signal = new Float64Array(n);
  let state = 1;
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    signal[i] = (state / 2 ** 31 - 1) * 10 ** ((-3 * (i / RATE)) / rt60);
  }
  const measured = decayTime(signal, RATE);
  assert.ok(Math.abs(measured - rt60) / rt60 < 0.05, `measured ${measured}`);
});

test('decayTime refuses to invent a number from silence', () => {
  assert.equal(decayTime(new Float64Array(1000), RATE), null);
});

test('peakFrequency finds a tone within a fraction of a bin', () => {
  const n = 4096;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i += 1) signal[i] = Math.sin((2 * Math.PI * 773.3 * i) / RATE);
  const spec = spectrum(signal, RATE);
  const { frequency } = peakFrequency(spec);
  assert.ok(Math.abs(frequency - 773.3) < spec.binHz / 4);
});
