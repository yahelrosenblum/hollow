// Saving, opening, sharing and recovering rooms.

import { button, el } from '../app/dom.js';
import { newId } from '../scene/room.js';
import { validateRoom } from '../scene/schema.js';
import { roomLink } from '../scene/sharelink.js';
import { makeScene } from '../scene/presets.js';
import { createRoom } from '../scene/room.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function safeFilename(name) {
  return (name || 'hollow').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'hollow';
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function installFiles(app, storage, autosave) {
  async function saveRoom() {
    const { room } = app;
    const checked = validateRoom(room);
    if (!checked.ok) {
      app.toast(`This room can't be saved: ${checked.error}`);
      return null;
    }
    const id = room.savedId ?? newId('r');
    const named = { ...room, savedId: id };
    await storage.put('rooms', { id, name: room.name, room: named, savedAt: Date.now() });
    app.commit(named, { undoable: false });
    app.toast(`Saved "${room.name}".`);
    return id;
  }
  app.saveRoom = () => saveRoom().catch((error) => app.toast(`Could not save: ${error.message}`));

  async function openSaved(close) {
    const saved = (await storage.all('rooms')).sort((a, b) => b.savedAt - a.savedAt);
    return el('div', {}, saved.length
      ? el('ul', { class: 'list' }, saved.map((entry) => el(
        'li',
        {},
        el(
          'div',
          { class: 'list-row' },
          el('span', { class: 'name', text: entry.name }),
          el('span', { class: 'note', style: 'margin:0', text: relativeTime(entry.savedAt) }),
          button('Open', async () => {
            const checked = validateRoom(entry.room);
            if (!checked.ok) {
              app.toast(`That room could not be read: ${checked.error}`);
              return;
            }
            close();
            await app.loadRoom({ ...checked.room, savedId: entry.id });
            app.renderPanel();
          }),
          button('Delete', async (event) => {
            await storage.delete('rooms', entry.id);
            event.target.closest('li').remove();
          }),
        ),
      )))
      : el('p', { text: 'No saved rooms yet.' }));
  }

  async function importFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      app.toast('That file is too large to be a room.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      app.toast('That file is not a Hollow room.');
      return;
    }
    const checked = validateRoom(parsed);
    if (!checked.ok) {
      app.toast(`That room could not be read: ${checked.error}`);
      return;
    }
    await app.loadRoom(checked.room);
    app.renderPanel();
    app.toast(`Opened "${checked.room.name}".`);
  }

  function exportRoom() {
    const { savedId: _drop, ...room } = app.room;
    downloadBlob(new Blob([JSON.stringify(room, null, 1)], { type: 'application/json' }), `${safeFilename(room.name)}.hollow.json`);
  }

  async function copyLink() {
    const { savedId: _drop, ...room } = app.room;
    const result = await roomLink(room, `${location.origin}${location.pathname}`);
    if (!result.ok) {
      app.toast(result.error);
      return null;
    }
    try {
      await navigator.clipboard.writeText(result.link);
      app.toast('Link copied. It contains the whole room, and nothing is uploaded.');
    } catch {
      app.toast('The browser blocked the clipboard. The link is in the address bar instead.');
      history.replaceState(null, '', result.link);
    }
    return result.link;
  }

  async function restoreVersion(entry, close) {
    const checked = validateRoom(entry.room);
    if (!checked.ok) {
      app.toast(`That version could not be read: ${checked.error}`);
      return;
    }
    close();
    await app.loadRoom(checked.room, { keepHistory: true });
    app.renderPanel();
    app.toast('Earlier version restored. Undo goes back.');
  }

  async function showFiles() {
    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      style: 'display:none',
      onchange: (event) => {
        const [file] = event.target.files;
        if (file) {
          app.dom.sheet.close();
          importFile(file);
        }
      },
    });
    const name = el('input', {
      type: 'text',
      value: app.room.name,
      maxLength: 80,
      'aria-label': 'Room name',
      oninput: (event) => app.commit({ ...app.room, name: event.target.value }, { group: 'name' }),
    });
    let list = null;
    let versionList = null;
    app.openSheet((close) => {
      list = el('div', {}, el('p', { text: 'Loading…' }));
      versionList = el('div', {});
      openSaved(close).then((node) => list.replaceChildren(node)).catch((error) => {
        list.replaceChildren(el('p', { text: `Saved rooms are unavailable here: ${error.message}` }));
      });
      autosave.versions(12).then((entries) => {
        versionList.replaceChildren(entries.length
          ? el('ul', { class: 'list' }, entries.map((entry) => el(
            'li',
            {},
            el(
              'div',
              { class: 'list-row' },
              el('span', { class: 'name', text: `${entry.room?.name ?? 'Room'}` }),
              el('span', { class: 'note', style: 'margin:0', text: relativeTime(entry.savedAt) }),
              button('Restore', () => restoreVersion(entry, close)),
            ),
          )))
          : el('p', { text: 'No earlier versions yet.' }));
      }).catch(() => {});
      return [
        el('h2', { text: 'This room' }),
        name,
        el(
          'div',
          { class: 'btn-row', style: 'margin-top:12px' },
          button('Save', saveRoom),
          button('Export file', exportRoom),
          button('Open file', () => fileInput.click()),
          button('Copy link', copyLink),
          button('New empty room', async () => {
            close();
            await app.loadRoom(createRoom({ name: 'Untitled room', ear: { x: 8, y: 3.5, angle: Math.PI } }));
            app.renderPanel();
            app.openWorkspace('build');
          }),
          fileInput,
        ),
        el('h3', { style: 'margin-top:24px;font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--paper-faint)', text: 'Saved on this device' }),
        list,
        el('h3', { style: 'margin-top:24px;font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--paper-faint)', text: 'Earlier versions (autosaved)' }),
        versionList,
        el('p', { style: 'color:var(--paper-faint)', text: 'Everything stays on this device. Hollow has no server.' }),
      ];
    });
  }

  // Dragging a room file onto the window opens it.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    const [file] = event.dataTransfer?.files ?? [];
    if (file && (file.name.endsWith('.json') || file.type === 'application/json')) {
      event.preventDefault();
      importFile(file);
    }
  });

  return { showFiles, exportRoom, copyLink, importFile };
}

export { makeScene };
