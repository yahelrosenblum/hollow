// The same measurement as bake.js, on the CPU reference. Tests use it to prove that challenges
// are solvable and that exported responses match direct simulation, without needing a GPU.

import { compileGrid } from './compile.js';
import { ReferenceSolver } from './reference.js';
import { sourceScale } from './host.js';
import { compileOptionsFor, rasterise, toCell } from '../scene/rasterise.js';
import { earPositions } from '../scene/room.js';
import {
  ClapSource, ImpulseSource, SourceFilter, ToneSource,
} from '../audio/sources.js';

function makeSignal(stimulus, rate) {
  switch (stimulus.kind) {
    case 'impulse':
      return new ImpulseSource(1);
    case 'clap':
      return new ClapSource(rate, 1, stimulus.seed ?? 7);
    case 'tone':
      return new ToneSource(rate, {
        frequency: stimulus.frequency,
        amplitude: stimulus.amplitude ?? 0.25,
        phase: stimulus.phase ?? 0,
        rampSeconds: stimulus.ramp ?? 0.01,
      });
    case 'samples': {
      const { signal } = stimulus;
      let at = 0;
      return {
        render(out, count) {
          for (let n = 0; n < count; n += 1) {
            out[n] = at < signal.length ? signal[at] : 0;
            at += 1;
          }
        },
      };
    }
    default:
      throw new RangeError(`unknown stimulus "${stimulus.kind}"`);
  }
}

export function bakeCpu({ room, sources, listeners, seconds, rate }) {
  const raster = rasterise(room, rate);
  const compiled = compileGrid(raster.grid, raster.nx, raster.ny, compileOptionsFor(room, rate, raster.margin));
  const solver = new ReferenceSolver(compiled);
  const steps = Math.round(seconds * rate);
  const cells = listeners === 'ears'
    ? Object.values(earPositions(room.ear)).map((p) => toCell(p, raster))
    : listeners.map((p) => toCell(p, raster));
  const voices = sources.map((s) => ({
    cell: toCell(s.point, raster),
    signal: makeSignal(s.stimulus, rate),
    diff: new SourceFilter(),
  }));
  const scale = sourceScale(rate);
  const traces = cells.map(() => new Float32Array(steps));
  const scratch = new Float32Array(1);
  for (let n = 0; n < steps; n += 1) {
    solver.step();
    for (const voice of voices) {
      voice.signal.render(scratch, 1, n);
      voice.diff.process(scratch, 1);
      if (scratch[0] !== 0) solver.inject(voice.cell.x, voice.cell.y, scratch[0] * scale);
    }
    cells.forEach((c, t) => { traces[t][n] = solver.sample(c.x, c.y); });
  }
  return { traces, rate };
}
