// Runs the full CPU physics audit and writes the measured results to docs/audit/cpu.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CHECKS } from '../src/audit/physics-checks.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const results = [];

for (const [name, check] of Object.entries(ALL_CHECKS)) {
  if (only.length && !only.includes(name)) continue;
  const started = Date.now();
  const outcome = check();
  const seconds = (Date.now() - started) / 1000;
  results.push({ ...outcome, seconds });
  const mark = outcome.pass ? 'PASS' : 'MISS';
  process.stdout.write(`${mark}  ${outcome.label}\n      target ${outcome.target}\n      measured ${outcome.measured}  (${seconds.toFixed(1)} s)\n`);
}

if (!only.length) {
  const outDir = join(root, 'docs', 'audit');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'cpu.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
}

const misses = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - misses.length} of ${results.length} met their proposed criteria\n`);
process.exitCode = misses.length ? 1 : 0;
