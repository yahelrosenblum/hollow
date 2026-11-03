// The first thing a visitor sees: the room already sounding behind one sentence and one button.
// Browsers won't play sound before a click, so until then the solver runs in slow motion with
// the display as its clock: real waves from real snaps, just slowed down, with no audio.

import { loadSetting, saveSetting } from '../app/dom.js';

// At real speed a clap crosses a cathedral in a twentieth of a second. At a thirty-second of it
// you can watch the ring travel, bounce off the columns and gather in the apse.
const PREVIEW_DIVISOR = 32;
const PREVIEW_CLAP_MS = 4200;
const LEAVE_MS = 900;
const COACHING = [
  'Tap anywhere to clap.',
  'Now drag the glowing circle. That\'s you.',
  'Try another room: tap its name at the top.',
];

export function mountWelcome(app) {
  const welcome = document.getElementById('welcome');
  const start = document.getElementById('welcome-start');
  if (!welcome || !start) return;
  let timer = 0;
  let step = 0;
  let showing = false;

  // At this speed the cathedral's echo hardly fades between snaps, so the preview starts each one
  // in a quiet room. Each ring is then one snap, travelling on its own.
  const clapSomewhere = async () => {
    await app.sim.request('clear').catch(() => {});
    // Start may have been pressed while the room was being quietened.
    if (!showing) return;
    const { width, height, ear } = app.room;
    // Somewhere in the room, away from the listener, so the wave has room to travel.
    const x = ear.x > width / 2 ? width * (0.2 + Math.random() * 0.25) : width * (0.55 + Math.random() * 0.25);
    const y = height * (0.3 + Math.random() * 0.4);
    app.sim.send('clap', { point: { x, y }, snap: true });
  };

  const coach = () => {
    app.setHint(COACHING[step] ?? '');
  };

  const advance = () => {
    step += 1;
    coach();
  };

  // Nothing behind the welcome answers the keyboard until it has gone.
  const holdKeys = (event) => {
    if (showing && !welcome.contains(event.target)) {
      event.stopImmediatePropagation();
    }
  };

  const dismiss = async ({ withClap = false } = {}) => {
    if (!showing) return;
    showing = false;
    clearInterval(timer);
    window.removeEventListener('keydown', holdKeys, true);
    welcome.classList.add('leaving');
    app.dom.app.inert = false;
    app.dom.app.classList.remove('welcoming');
    app.applyLayout();
    setTimeout(() => { welcome.hidden = true; }, LEAVE_MS);
    saveSetting('welcomed', true);
    // The last preview snap would otherwise still be ringing when the sound comes on.
    try {
      await app.sim.request('clear');
      await app.sim.request('timeLive');
    } catch (error) {
      app.toast(`The simulation could not start: ${error.message}`);
    }
    app.dom.overlay.focus({ preventScroll: true });
    if (withClap) {
      app.ensureAudio();
      const { width, height } = app.room;
      const point = { x: width * 0.35, y: height * 0.5 };
      app.overlay.mark(point);
      app.lastClap = point;
      app.sim.send('clap', { point });
    }
    step = 0;
    coach();
  };

  app.dismissWelcome = () => dismiss();
  start.addEventListener('click', () => dismiss({ withClap: true }));

  // Coaching moves on as the visitor does each thing once.
  app.onFirstClap = () => { if (step === 0) advance(); };
  app.onRoom((room) => {
    if (step === 1 && room.ear && app.dragging) advance();
  });
  document.getElementById('room-name')?.addEventListener('click', () => { if (step === 2) advance(); });

  if (loadSetting('welcomed', false)) {
    coach();
    return;
  }
  showing = true;
  welcome.hidden = false;
  app.dom.app.inert = true;
  app.dom.app.classList.add('welcoming');
  window.addEventListener('keydown', holdKeys, true);
  app.applyLayout();
  // The words reflow when the fonts arrive, and the room is placed beside them.
  document.fonts?.ready.then(() => { if (showing) app.applyLayout(); });
  app.sim.request('timeSlow', { divisor: PREVIEW_DIVISOR }).then(() => {
    if (!showing) return;
    clapSomewhere();
    timer = setInterval(clapSomewhere, PREVIEW_CLAP_MS);
  }).catch(() => {});
  start.focus({ preventScroll: true });
}
