// Challenge Mode. The Test button bakes the room as it stands, and only measurements count.

import { button, el } from '../../app/dom.js';
import { roomToScreen } from '../../scene/layout.js';
import { CHALLENGES, CHALLENGE_RATE, LEVELS, materialUsed } from './definitions.js';

const PROGRESS_KEY = 'challenge-progress';

export function challengesWorkspace(app) {
  const state = {
    current: null,
    outcome: null,
    testing: false,
    progress: {},
    removeLayer: null,
  };
  let host;

  const simulate = (request) => app.sim.request('bake', request);

  async function loadProgress() {
    const stored = await app.storage.get('meta', PROGRESS_KEY).catch(() => null);
    state.progress = stored?.passed ?? {};
    app.renderPanelIfActive?.('challenges');
    if (app.active?.key === 'challenges') renderBody();
  }

  function saveProgress() {
    app.storage.put('meta', { key: PROGRESS_KEY, passed: state.progress }).catch(() => {});
  }

  async function open(challenge) {
    state.current = challenge;
    state.outcome = null;
    await app.loadRoom(challenge.start());
    app.overlay.dirty = true;
    renderBody();
    app.announce(`Challenge: ${challenge.title}`);
  }

  async function restart() {
    if (state.current) await open(state.current);
  }

  async function runTest() {
    if (state.testing || !state.current) return;
    state.testing = true;
    renderBody();
    try {
      const outcome = await state.current.test(app.room, simulate);
      state.outcome = outcome;
      if (outcome.pass) {
        state.progress = { ...state.progress, [state.current.key]: true };
        saveProgress();
      }
      app.announce(outcome.pass ? 'Passed' : 'Not yet');
    } catch (error) {
      app.toast(`The test could not run: ${error.message}`);
    } finally {
      state.testing = false;
      renderBody();
    }
  }

  function drawMarkers(ctx, view) {
    if (!state.current) return;
    ctx.font = '11px "IBM Plex Mono", monospace';
    for (const marker of state.current.markers) {
      const c = roomToScreen(view, marker.point);
      ctx.strokeStyle = '#e9a95c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c.x - 8, c.y - 8);
      ctx.lineTo(c.x + 8, c.y + 8);
      ctx.moveTo(c.x + 8, c.y - 8);
      ctx.lineTo(c.x - 8, c.y + 8);
      ctx.stroke();
      const width = ctx.measureText(marker.label).width;
      ctx.fillStyle = 'rgba(11,16,21,0.85)';
      ctx.fillRect(c.x + 10, c.y - 8, width + 8, 16);
      ctx.fillStyle = '#e9a95c';
      ctx.fillText(marker.label, c.x + 14, c.y + 4);
    }
  }

  function renderList() {
    const families = [...new Set(CHALLENGES.map((c) => c.family))];
    const done = Object.keys(state.progress).length;
    return [
      el('p', { class: 'placard', text: 'Each one is a problem you solve with geometry and materials. Nothing here rewards how a room looks: only what the simulation measures.' }),
      el('p', { class: 'note', text: `${done} of ${CHALLENGES.length} solved.` }),
      ...families.map((family) => {
        const levels = CHALLENGES.filter((c) => c.family === family);
        return el(
          'div',
          { style: 'margin-top:14px;padding-top:10px;border-top:1px solid var(--hairline)' },
          el('p', { style: 'margin:0 0 6px;font-family:var(--serif);font-size:17px', text: levels[0].title }),
          el('div', { class: 'btn-row', style: 'margin:0' }, levels.map((c) => button(
            `${state.progress[c.key] ? '✓ ' : ''}${LEVELS[c.level]}`,
            () => open(c),
            { 'aria-label': `${c.title}, ${LEVELS[c.level]}${state.progress[c.key] ? ', solved' : ''}` },
          ))),
        );
      }),
    ];
  }

  function renderOutcome() {
    const { outcome, current } = state;
    if (!outcome) return null;
    return el(
      'div',
      {},
      el('p', {
        style: `font-family:var(--serif);font-size:22px;margin:12px 0 4px;color:${outcome.pass ? 'var(--good)' : 'var(--paper)'}`,
        text: outcome.pass ? 'Solved.' : 'Not yet.',
        role: 'status',
      }),
      el('dl', { class: 'metrics' }, outcome.rows.flatMap((r) => [
        el('dt', { text: `${r.ok ? '✓' : '✗'} ${r.label}` }),
        el('dd', { text: r.measured, style: r.ok ? undefined : 'color:var(--alert)' }),
        el('dt', { style: 'padding-left:14px', text: 'needed' }),
        el('dd', { class: 'note', style: 'margin:0', text: r.target }),
      ])),
      outcome.pass ? el('h3', { text: 'Why it worked' }) : null,
      outcome.pass ? el('p', { class: 'placard', text: current.phenomenon }) : null,
    );
  }

  function renderCurrent() {
    const c = state.current;
    const used = materialUsed(app.room);
    return [
      el('p', { class: 'note', style: 'margin:0', text: LEVELS[c.level] }),
      el('p', { style: 'margin:2px 0 8px;font-family:var(--serif);font-size:19px', text: c.title }),
      el('p', { class: 'placard', text: c.objective }),
      c.budget ? el('p', { class: 'note', text: `Material used: ${used.toFixed(1)} of ${c.budget}. Fixed walls are free.` }) : null,
      el(
        'div',
        { class: 'btn-row' },
        button(state.testing ? 'Testing…' : 'Test this room', runTest, { class: 'btn primary', disabled: state.testing }),
        button(c.usesSpeakers ? 'Edit speakers' : 'Build', () => app.openWorkspace(c.usesSpeakers ? 'sources' : 'build')),
        button('Start over', restart),
      ),
      el('p', { class: 'note', text: `Clap to hear it as you go. The test runs at ${CHALLENGE_RATE / 1000} kHz on any machine, so a score doesn't depend on your GPU.` }),
      renderOutcome(),
      el('div', { class: 'btn-row', style: 'margin-top:14px' }, button('All challenges', () => {
        state.current = null;
        state.outcome = null;
        app.overlay.dirty = true;
        renderBody();
      })),
    ].filter(Boolean);
  }

  function renderBody() {
    if (!host) return;
    host.replaceChildren(...(state.current ? renderCurrent() : renderList()));
  }

  function render() {
    host = el('div', {});
    renderBody();
    return [el('h2', { text: 'Challenges' }), host];
  }

  return {
    key: 'challenges',
    label: 'Challenge',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
      loadProgress();
    },
    onRoomChange() {
      if (state.current && app.active?.key === 'challenges' && !state.testing) renderBody();
    },
    // Markers stay on the field while building, or the player would be working blind.
    install() {
      state.removeLayer = app.overlay.addLayer(drawMarkers);
    },
    runTest,
    open,
    get outcome() {
      return state.outcome;
    },
    get current() {
      return state.current;
    },
  };
}
