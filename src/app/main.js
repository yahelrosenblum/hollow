// Entry point. Checks the machine can run Hollow, then assembles the workspaces.

import { App } from './app.js';
import { el, saveSetting } from './dom.js';
import { listenWorkspace } from '../features/listen/listen.js';
import { xrayWorkspace } from '../features/xray/xray.js';
import { spectrumWorkspace } from '../features/spectrum/spectrum.js';
import { buildWorkspace } from '../features/build/build.js';
import { sourcesWorkspace } from '../features/sources/sources.js';
import { timelabWorkspace } from '../features/timelab/timelab.js';
import { labWorkspace } from '../features/lab/lab.js';
import { perfWorkspace } from '../features/perf/perf.js';
import { studioWorkspace } from '../features/studio/studio.js';
import { challengesWorkspace } from '../features/challenges/challenges.js';
import { mountStatus } from '../ui/status.js';
import { bindShortcuts, showShortcuts } from '../ui/shortcuts.js';
import { installFiles } from '../ui/files.js';
import { mountWelcome } from '../ui/welcome.js';
import { drawRoomThumbnail } from '../ui/thumbnail.js';
import { SCENES, makeScene } from '../scene/presets.js';
import { Storage } from '../scene/storage.js';
import { Autosave } from '../scene/autosave.js';
import { decodeRoom, roomFromHash } from '../scene/sharelink.js';

function unsupported(reason) {
  const note = document.getElementById('boot-note');
  const word = document.querySelector('.boot-word');
  word.textContent = 'Hollow needs WebGPU';
  word.style.fontSize = '32px';
  note.textContent = reason;
}

function showDisclosure(app) {
  app.openSheet(() => [
    el('h2', { text: 'How it works' }),
    el('p', { text: 'Sound is waves of air pressure. Hollow splits your room into a grid of tiny cells and, tens of thousands of times a second, works out how the pressure in each cell pushes on its neighbours. That one rule is the whole simulation. What you see is that pressure: gold where the air is squeezed, cyan where it is stretched.' }),
    el('p', { text: 'What you hear is the pressure at two cells beside your head, one for each ear. There is no reverb, panning, Doppler or occlusion effect anywhere in the code. Echoes, the muffled sound behind a door, and sound bending round corners all come out of the waves themselves.' }),
    el('p', { text: 'This is a 2D simulation. It behaves like a very tall room, with long low-frequency tails, so it will not match a real three-dimensional building. Treat it as an instrument and a way to understand sound, not as a prediction of a real space.' }),
    el('p', { text: 'Between the ear cells and your speakers there are exactly five steps:' }),
    el(
      'ul',
      {},
      el('li', { text: 'A filter that flattens the frequency tilt of 2D propagation.' }),
      el('li', { text: 'A blocker for constant pressure, which you could not hear anyway.' }),
      el('li', { text: 'A filter at the edge of the grid\'s frequency range, because the grid itself rings there, in any room.' }),
      el('li', { text: 'A resampler up to your sound card\'s rate.' }),
      el('li', { text: 'A safety limiter, to protect your hearing. Exports skip it.' }),
    ),
    el('p', { text: `Right now the simulation runs at ${(app.rate ?? 0) / 1000} kHz, which limits sound to about ${((app.rate ?? 0) * 0.25 / 1000).toFixed(1)} kHz. That is why it sounds darker than a recording.` }),
  ]);
}

function showScenes(app) {
  const thumbnails = [];
  app.openSheet((close) => [
    el('h2', { text: 'Rooms' }),
    el('p', { text: 'Each one is built from the same walls and materials you can draw yourself. Pick one, then clap.' }),
    el('div', { class: 'scene-list' }, SCENES.map((scene) => {
      const room = scene.make();
      const picture = el('canvas', { class: 'scene-thumb', 'aria-hidden': 'true' });
      thumbnails.push([picture, room]);
      return el(
        'button',
        {
          type: 'button',
          class: 'scene-item',
          'aria-current': app.room.sceneKey === scene.key ? 'true' : null,
          onclick: async () => {
            close();
            await app.loadRoom(makeScene(scene.key));
            app.openWorkspace('listen');
            app.renderPanel();
          },
        },
        picture,
        el('strong', { text: room.name }),
        el('span', { text: room.blurb }),
      );
    })),
  ]);
  // Drawn once the sheet is laid out, so each picture knows its size.
  requestAnimationFrame(() => thumbnails.forEach(([canvas, room]) => drawRoomThumbnail(canvas, room)));
  setTimeout(() => thumbnails.forEach(([canvas, room]) => { if (!canvas.width || canvas.width === 300) drawRoomThumbnail(canvas, room); }), 120);
}

async function main() {
  if (!navigator.gpu) {
    unsupported('Your browser does not expose WebGPU. Chrome, Edge and recent versions of Safari and Firefox support it. Hollow has no fallback, because nothing else is fast enough to compute sound in real time.');
    return;
  }
  const app = new App();
  window.hollow = app;
  app.setPalette = (key) => {
    app.palette = key;
    saveSetting('palette', key);
    app.sim.send('setView', { palette: key });
  };
  app.setBrightness = (value) => {
    app.brightness = value;
    saveSetting('brightness', value);
    app.sim.send('setView', { brightness: value });
  };

  const storage = new Storage();
  const autosave = new Autosave(storage, {
    onError: (error) => app.toast(`Autosave failed: ${error.message}`),
  });
  const files = installFiles(app, storage, autosave);
  app.storage = storage;
  app.autosave = autosave;

  const openScenes = () => showScenes(app);
  app.dom.roomName.addEventListener('click', openScenes);
  app.dom.disclosure.addEventListener('click', () => showDisclosure(app));
  app.registerWorkspace(listenWorkspace(app, { openScenes, showFiles: files.showFiles }));
  app.registerWorkspace(buildWorkspace(app));
  app.registerWorkspace(sourcesWorkspace(app));
  app.registerWorkspace(xrayWorkspace(app));
  app.registerWorkspace(spectrumWorkspace(app));
  app.registerWorkspace(labWorkspace(app));
  app.registerWorkspace(timelabWorkspace(app));
  app.registerWorkspace(studioWorkspace(app));
  const challenges = challengesWorkspace(app);
  app.registerWorkspace(challenges);
  challenges.install();
  app.registerWorkspace(perfWorkspace(app));
  mountStatus(app);
  bindShortcuts(app);
  app.showShortcuts = () => showShortcuts(app);

  const { room: startRoom, note: startNote } = await chooseStartRoom(autosave);
  app.onRoom((room) => autosave.note(room));

  try {
    await app.start({ room: startRoom });
    autosave.begin();
  } catch (error) {
    const message = error?.message ?? String(error);
    if (message === 'no-webgpu' || message === 'no-adapter') {
      unsupported('This browser has WebGPU, but no usable graphics adapter was found. Hollow needs a GPU to compute sound in real time.');
    } else {
      app.fail('Hollow could not start.', message);
    }
    return;
  }
  app.openWorkspace('listen');
  mountWelcome(app);
  if (startNote) app.toast(startNote);
  // Closing properly is what tells the next launch this wasn't a crash.
  window.addEventListener('pagehide', () => autosave.endCleanly());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) autosave.reopen();
  });
}

// A shared link wins, then a room recovered from the journal, then the cathedral.
async function chooseStartRoom(autosave) {
  const encoded = roomFromHash(location.hash);
  if (encoded) {
    const result = await decodeRoom(encoded);
    if (result.ok) {
      history.replaceState(null, '', location.pathname);
      return { room: result.room, note: `Opened "${result.room.name}" from a link.` };
    }
    return { room: makeScene('cathedral'), note: result.error };
  }
  try {
    const recovered = await autosave.recover();
    if (recovered.room) {
      const damaged = recovered.skipped ? ' One damaged save was skipped.' : '';
      return {
        room: recovered.room,
        note: recovered.crashed
          ? `Hollow did not close properly last time. "${recovered.room.name}" has been restored.${damaged}`
          : (damaged || null),
      };
    }
  } catch {
    // Storage may be blocked in this window. Rooms still work; they just won't persist.
  }
  return { room: makeScene('cathedral'), note: null };
}

main();
