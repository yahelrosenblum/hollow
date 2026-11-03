// Chooses the simulation rate. Compute grows with the cube of the rate, so a step down buys a
// lot. It only ever steps down on its own, and only on evidence that audio is suffering;
// stepping up again is the user's choice, because a wrong guess there is audible.

export const RATES = Object.freeze([22050, 16000, 11025, 8000]);

const REQUIRED_HEADROOM = 1.3;
const UNDERRUN_LIMIT = 2;
const WINDOW_MS = 8000;
const SETTLE_MS = 3000;

// Highest rate whose measured speed leaves headroom. If none does, the lowest rate is the
// best available, and the caller can say so.
export function chooseRate(measurements) {
  const sorted = [...measurements].sort((a, b) => b.rate - a.rate);
  const good = sorted.find((m) => m.realtime >= REQUIRED_HEADROOM);
  if (good) return { rate: good.rate, confident: true };
  return { rate: sorted[sorted.length - 1].rate, confident: false };
}

export class Governor {
  constructor(rate, { now = 0, automatic = true, observed = true } = {}) {
    this.rate = rate;
    this.automatic = automatic;
    this.observed = observed;
    this.events = [];
    this.settledAt = now + SETTLE_MS;
    this.lastUnderruns = 0;
  }

  setRate(rate, now) {
    this.rate = rate;
    this.settle(now);
  }

  // Rebuilding a room stalls audio for a moment. That says nothing about the GPU, so what
  // happens straight after one doesn't count as evidence.
  settle(now) {
    this.events = [];
    this.settledAt = now + SETTLE_MS;
  }

  // Browsers stall a hidden page's audio for seconds at a time, even an empty worklet's, unless
  // it's audibly playing. That says nothing about the GPU either.
  setObserved(observed, now) {
    this.observed = observed;
    this.settle(now);
  }

  // Feed it the running underrun total. Returns a lower rate when one is called for.
  note(underruns, now) {
    if (underruns > this.lastUnderruns) {
      const added = underruns - this.lastUnderruns;
      this.lastUnderruns = underruns;
      // Changing rate restarts audio, so what happens straight after a change doesn't count.
      if (this.observed && now >= this.settledAt) for (let i = 0; i < added; i += 1) this.events.push(now);
    }
    this.events = this.events.filter((t) => now - t <= WINDOW_MS);
    if (!this.automatic || !this.observed || now < this.settledAt || this.events.length < UNDERRUN_LIMIT) return null;
    const index = RATES.indexOf(this.rate);
    if (index < 0 || index === RATES.length - 1) return null;
    return RATES[index + 1];
  }
}
