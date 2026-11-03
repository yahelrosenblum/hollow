// Signal measurement. Pure functions, shared by the audit, the UI and Challenge Mode,
// so a number on screen and a number in a test always come from the same code.

export function nextPowerOfTwo(n) {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1 || 1));
  return w;
}

// In-place radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new RangeError('fft size must be a power of two');
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
}

// Windowed magnitude spectrum. `padTo` zero-pads for finer peak location.
export function spectrum(signal, rate, { window = true, padTo = 0 } = {}) {
  const size = nextPowerOfTwo(Math.max(signal.length, padTo));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const w = window ? hann(signal.length) : null;
  for (let i = 0; i < signal.length; i += 1) re[i] = signal[i] * (w ? w[i] : 1);
  fft(re, im);
  const bins = size / 2 + 1;
  const magnitude = new Float64Array(bins);
  for (let i = 0; i < bins; i += 1) magnitude[i] = Math.hypot(re[i], im[i]);
  return { magnitude, binHz: rate / size, re, im };
}

// Parabolic interpolation around the strongest bin in a frequency range.
export function peakFrequency(spec, fromHz = 0, toHz = Infinity) {
  const { magnitude, binHz } = spec;
  const lo = Math.max(1, Math.ceil(fromHz / binHz));
  const hi = Math.min(magnitude.length - 2, Math.floor(toHz / binHz));
  let best = lo;
  for (let i = lo; i <= hi; i += 1) if (magnitude[i] > magnitude[best]) best = i;
  const a = Math.log(magnitude[best - 1] + 1e-30);
  const b = Math.log(magnitude[best] + 1e-30);
  const c = Math.log(magnitude[best + 1] + 1e-30);
  const denom = a - 2 * b + c;
  const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return { frequency: (best + shift) * binHz, magnitude: magnitude[best], bin: best };
}

export function db(value) {
  return 20 * Math.log10(Math.max(Math.abs(value), 1e-30));
}

export function rms(signal, from = 0, to = signal.length) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

export function peakIn(signal, from = 0, to = signal.length) {
  let max = 0;
  for (let i = from; i < to; i += 1) max = Math.max(max, Math.abs(signal[i]));
  return max;
}

// Reverberation time by Schroeder backward integration: fits the -5 to -35 dB range of the
// energy decay curve and extrapolates to -60 dB. Returns null when the decay is too short
// to measure rather than inventing a number.
export function decayTime(impulseResponse, rate) {
  const n = impulseResponse.length;
  const edc = new Float64Array(n);
  let sum = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    sum += impulseResponse[i] * impulseResponse[i];
    edc[i] = sum;
  }
  if (sum <= 0) return null;
  const total = edc[0];
  // Backward integration always reaches zero at the end of the recording, even if the sound
  // hasn't died away, and would then report a confident wrong answer. If the last stretch is
  // still within 40 dB of the opening, the recording is too short to say.
  const stretch = Math.max(1, Math.floor(n * 0.05));
  const opening = (edc[0] - edc[stretch]) / stretch;
  const closing = edc[n - stretch] / stretch;
  if (opening <= 0 || closing / opening > 1e-4) return null;
  const levelAt = (i) => 10 * Math.log10(edc[i] / total);
  let start = -1;
  let end = -1;
  for (let i = 0; i < n; i += 1) {
    const level = levelAt(i);
    if (start < 0 && level <= -5) start = i;
    if (level <= -35) {
      end = i;
      break;
    }
  }
  if (start < 0 || end <= start) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const count = end - start + 1;
  for (let i = start; i <= end; i += 1) {
    const t = i / rate;
    const y = levelAt(i);
    sx += t;
    sy += y;
    sxx += t * t;
    sxy += t * y;
  }
  const slope = (count * sxy - sx * sy) / (count * sxx - sx * sx);
  if (!(slope < 0)) return null;
  return -60 / slope;
}
