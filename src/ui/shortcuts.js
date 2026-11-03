// Keyboard shortcuts. A table, so the reference sheet can never go out of date with what the
// keys actually do. They never fire while typing in a field.

import { el } from '../app/dom.js';
import { TOOL_LIST } from '../features/build/build.js';

export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.type ?? 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button'].includes(type);
  }
  return false;
}

export function keyName(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  // Shift already shows in a typed character ("?"), unless Ctrl or Alt is also held.
  if (event.shiftKey && (event.key.length > 1 || event.ctrlKey || event.metaKey || event.altKey)) parts.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key === ' ' ? 'Space' : key);
  return parts.join('+');
}

export function shortcutTable(app) {
  const buildSpace = () => app.workspaces.find((w) => w.key === 'build');
  const inBuild = () => app.active?.key === 'build';
  const openTool = (key) => {
    app.openWorkspace('build');
    buildSpace().chooseTool(key);
  };
  const rows = [
    { group: 'Everywhere', keys: 'Ctrl+Z', label: 'Undo', run: () => app.undo() },
    { group: 'Everywhere', keys: 'Ctrl+Y', label: 'Redo', run: () => app.redo() },
    { group: 'Everywhere', keys: 'Ctrl+Shift+Z', label: 'Redo', run: () => app.redo(), hidden: true },
    { group: 'Everywhere', keys: 'Ctrl+S', label: 'Save this room', run: () => app.saveRoom?.() },
    { group: 'Everywhere', keys: '?', label: 'Show these shortcuts', run: () => showShortcuts(app) },
    {
      group: 'Everywhere',
      keys: 'Space',
      label: 'Clap at the cursor, or the middle of the room',
      run: () => {
        const point = app.cursor ?? app.hover ?? { x: app.room.width / 2, y: app.room.height / 2 };
        if (app.isInside(point)) {
          app.ensureAudio();
          app.lastClap = point;
          app.overlay.mark(point);
          app.sim.send('clap', { point });
        }
      },
    },
    ...app.workspaces.map((w, n) => ({
      group: 'Workspaces',
      // The tenth workspace is on 0, as on a keyboard's number row.
      keys: String((n + 1) % 10),
      label: w.label,
      run: () => app.openWorkspace(w.key),
    })),
    ...TOOL_LIST.map((t) => ({
      group: 'Build tools',
      keys: t.shortcut,
      label: t.label,
      run: () => openTool(t.key),
    })),
    { group: 'Build', keys: 'Shift+Enter', label: 'Finish a wall', when: inBuild, run: () => buildSpace().finishPath() },
    { group: 'Build', keys: 'Escape', label: 'Cancel what you are drawing', when: inBuild, run: () => buildSpace().cancelTool() },
    { group: 'Build', keys: 'Ctrl+D', label: 'Duplicate the selection', when: inBuild, run: () => buildSpace().duplicateSelected() },
    { group: 'Build', keys: 'Delete', label: 'Delete the selection', when: inBuild, run: () => buildSpace().deleteSelected() },
    { group: 'Build', keys: 'Backspace', label: 'Delete the selection', when: inBuild, run: () => buildSpace().deleteSelected(), hidden: true },
    { group: 'Build', keys: '[', label: 'Rotate the selection left', when: inBuild, run: () => buildSpace().rotateSelected(-Math.PI / 24) },
    { group: 'Build', keys: ']', label: 'Rotate the selection right', when: inBuild, run: () => buildSpace().rotateSelected(Math.PI / 24) },
    { group: 'Build', keys: '-', label: 'Make the selection smaller', when: inBuild, run: () => buildSpace().scaleSelected(1 / 1.05) },
    { group: 'Build', keys: '=', label: 'Make the selection bigger', when: inBuild, run: () => buildSpace().scaleSelected(1.05) },
    { group: 'Build', keys: 'Alt+ArrowLeft', label: 'Nudge the selection left', when: inBuild, run: () => buildSpace().nudge(-1, 0) },
    { group: 'Build', keys: 'Alt+ArrowRight', label: 'Nudge the selection right', when: inBuild, run: () => buildSpace().nudge(1, 0) },
    { group: 'Build', keys: 'Alt+ArrowUp', label: 'Nudge the selection up', when: inBuild, run: () => buildSpace().nudge(0, -1) },
    { group: 'Build', keys: 'Alt+ArrowDown', label: 'Nudge the selection down', when: inBuild, run: () => buildSpace().nudge(0, 1) },
  ];
  return rows;
}

export function bindShortcuts(app) {
  document.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target)) return;
    if (document.getElementById('sheet').open) return;
    const name = keyName(event);
    const rows = shortcutTable(app);
    const row = rows.find((r) => r.keys === name && (!r.when || r.when()));
    if (!row) return;
    // On a focused button or slider, Space and Enter belong to that control.
    const onControl = event.target?.closest?.('button, input, select, a, summary');
    if (onControl && (name === 'Space' || name === 'Enter')) return;
    // On the room itself, those two keys act at the cursor: that's the canvas's own handler.
    if (event.target === app.dom.overlay && (name === 'Space' || name === 'Enter')) return;
    event.preventDefault();
    row.run();
  });
}

export function showShortcuts(app) {
  const rows = shortcutTable(app).filter((r) => !r.hidden);
  const groups = [...new Set(rows.map((r) => r.group))];
  app.openSheet(() => [
    el('h2', { text: 'Keyboard' }),
    ...groups.map((group) => el(
      'div',
      {},
      el('h3', { style: 'margin:16px 0 6px;font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--paper-faint)', text: group }),
      el('dl', { class: 'metrics' }, rows.filter((r) => r.group === group).flatMap((r) => [
        el('dt', { text: r.label }),
        el('dd', { text: r.keys.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓') }),
      ])),
    )),
    el('p', { text: 'In the room itself: arrow keys move a cursor, Shift moves it faster, and Enter acts at that spot.' }),
  ]);
}
