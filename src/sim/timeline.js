// Remembers what was injected at each step, by absolute step number. That makes two things
// possible: running time exactly backward, which needs each value put back where it went in,
// and re-simulating from a checkpoint, which needs the same values again in the same order.

const MAX_ENTRIES = 60000;

export class SourceLog {
  constructor() {
    this.clear();
  }

  clear() {
    this.entries = [];
  }

  get start() {
    return this.entries.length ? this.entries[0].start : 0;
  }

  get end() {
    const last = this.entries[this.entries.length - 1];
    return last ? last.start + last.count : 0;
  }

  // Everything from `step` on is a future that no longer happens.
  truncate(step) {
    while (this.entries.length) {
      const last = this.entries[this.entries.length - 1];
      if (last.start >= step) {
        this.entries.pop();
      } else {
        if (last.start + last.count > step) {
          last.count = step - last.start;
          if (last.samples) last.samples = last.samples.slice(0, last.count * last.injectors.length);
        }
        return;
      }
    }
  }

  record(start, count, injectors, samples) {
    const last = this.entries[this.entries.length - 1];
    if (!injectors.length && last && !last.injectors.length && last.start + last.count === start) {
      last.count += count;
    } else {
      this.entries.push({
        start,
        count,
        injectors,
        samples: injectors.length ? samples.slice() : null,
      });
    }
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  entryAt(step) {
    let low = 0;
    let high = this.entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const entry = this.entries[middle];
      if (step < entry.start) high = middle - 1;
      else if (step >= entry.start + entry.count) low = middle + 1;
      else return entry;
    }
    return null;
  }

  // What was injected for steps `step` onward, up to `wanted`, within one entry so the
  // injector list is constant. Null when that stretch of time isn't in the log.
  forwardFrom(step, wanted) {
    const entry = this.entryAt(step);
    if (!entry) return null;
    const offset = step - entry.start;
    const count = Math.min(wanted, entry.count - offset);
    const stride = entry.injectors.length;
    const injectors = entry.injectors.map((p) => ({
      x: p.x + p.dx * offset, y: p.y + p.dy * offset, dx: p.dx, dy: p.dy,
    }));
    const samples = stride ? entry.samples.slice(offset * stride, (offset + count) * stride) : new Float32Array(0);
    return { count, injectors, samples };
  }

  // Going backward from just before `step`: the same values, in reverse order.
  backwardFrom(step, wanted) {
    const entry = this.entryAt(step - 1);
    if (!entry) return null;
    const lastOffset = step - 1 - entry.start;
    const count = Math.min(wanted, lastOffset + 1);
    const stride = entry.injectors.length;
    const injectors = entry.injectors.map((p) => ({
      x: p.x + p.dx * lastOffset, y: p.y + p.dy * lastOffset, dx: -p.dx, dy: -p.dy,
    }));
    const samples = new Float32Array(count * stride);
    for (let n = 0; n < count; n += 1) {
      for (let s = 0; s < stride; s += 1) {
        samples[n * stride + s] = entry.samples[(lastOffset - n) * stride + s];
      }
    }
    return { count, injectors, samples };
  }
}
