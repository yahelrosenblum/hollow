import { GPU_CHECKS } from './gpu-checks.js';

const log = document.getElementById('log');
const runButton = document.getElementById('run');

function write(line) {
  log.textContent += `${line}\n`;
}

export async function runGpuAudit(only = null) {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found');
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  });
  device.addEventListener('uncapturederror', (event) => write(`GPU error: ${event.error.message}`));
  const results = [];
  for (const [name, check] of Object.entries(GPU_CHECKS)) {
    if (only && !only.includes(name)) continue;
    write(`running ${name}...`);
    const started = performance.now();
    const result = await check(device);
    const seconds = (performance.now() - started) / 1000;
    results.push({ ...result, seconds });
    write(`${result.pass ? 'PASS' : 'MISS'}  ${result.label}\n      target ${result.target}\n      measured ${result.measured}  (${seconds.toFixed(1)} s)`);
  }
  const report = {
    when: new Date().toISOString(),
    adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture },
    results,
  };
  if (!only) {
    await fetch('/__audit/gpu', { method: 'POST', body: JSON.stringify(report) });
  }
  write(`\n${results.filter((r) => r.pass).length} of ${results.length} met their proposed criteria`);
  device.destroy();
  return report;
}

runButton.addEventListener('click', () => {
  runButton.disabled = true;
  runGpuAudit().catch((error) => write(`FAILED: ${error.message}`)).finally(() => {
    runButton.disabled = false;
  });
});

window.hollowAudit = runGpuAudit;
