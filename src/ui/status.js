// The status line. Plain numbers about the simulation itself, always visible.

import { el } from '../app/dom.js';

export function mountStatus(app) {
  const parts = {
    rate: el('b'),
    grid: el('b'),
    delay: el('b'),
    fps: el('b'),
    dropouts: el('b'),
    dropoutWord: el('span', { text: ' dropouts' }),
    limiter: el('span', { class: 'warn' }),
  };
  const openPerf = el('button', {
    type: 'button',
    class: 'link-btn',
    style: 'padding:0;font-size:11px',
    text: 'Performance',
    onclick: () => app.openWorkspace('perf'),
  });
  app.dom.readout.replaceChildren(
    el('span', {}, parts.rate),
    el('span', { class: 'readout-extra' }, 'Grid ', parts.grid),
    el('span', {}, 'Delay ', parts.delay),
    el('span', { class: 'readout-extra' }, parts.fps, ' fps'),
    el('span', {}, parts.dropouts, parts.dropoutWord),
    parts.limiter,
    el('span', { class: 'grow' }, openPerf),
  );

  app.addStatsListener(({ stats }) => {
    parts.rate.textContent = `${(stats.rate / 1000).toFixed(stats.rate % 1000 ? 1 : 0)} kHz`;
    if (app.size) parts.grid.textContent = `${(app.size.dx * 100).toFixed(1)} cm`;
    const device = app.output ? app.output.outputLatency() * 1000 : 0;
    parts.delay.textContent = `${Math.round(stats.targetSeconds * 1000 + device)} ms`;
    parts.fps.textContent = Math.round(stats.fps ?? 0);
    parts.dropouts.textContent = stats.underruns;
    parts.dropoutWord.textContent = stats.underruns === 1 ? ' dropout' : ' dropouts';
    parts.limiter.textContent = stats.limiterReduction > 0.02 ? 'Limiter active' : '';
  });
}
