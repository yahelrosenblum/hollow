// The application core: one room, one simulation, one active workspace, one active tool.
// Workspaces (listen, build, inspect...) plug in here and stay ignorant of each other.

import { History } from './history.js';
import { Overlay } from './overlay.js';
import { SimClient } from './sim-client.js';
import { el, loadSetting, saveSetting, setCanvasSize } from './dom.js';
import { createAudioOutput } from '../audio/output.js';
import { clampToRoom, fitView, insideRoom, screenToRoom } from '../scene/layout.js';
import { makeScene } from '../scene/presets.js';
import { DEFAULT_PALETTE } from '../render/palettes.js';
import { GROUP_ENDS, icon } from '../ui/icons.js';

const CURSOR_STEP = 0.1;
const STATUS_ANNOUNCE_MS = 4000;

export class App {
  constructor() {
    this.dom = {
      app: document.getElementById('app'),
      stage: document.getElementById('stage'),
      field: document.getElementById('field'),
      overlay: document.getElementById('overlay'),
      panel: document.getElementById('panel'),
      rail: document.getElementById('rail'),
      readout: document.getElementById('readout'),
      roomName: document.getElementById('room-name'),
      disclosure: document.getElementById('disclosure'),
      hint: document.getElementById('hint'),
      timeBadge: document.getElementById('time-badge'),
      boot: document.getElementById('boot'),
      bootNote: document.getElementById('boot-note'),
      sheet: document.getElementById('sheet'),
      toast: document.getElementById('toast'),
      announcer: document.getElementById('announcer'),
    };
    this.sim = new SimClient();
    this.overlay = new Overlay(this.dom.overlay);
    this.history = new History(null);
    this.workspaces = [];
    this.active = null;
    this.tool = null;
    this.view = null;
    this.dpr = 1;
    this.cursor = null;
    this.stats = null;
    this.level = 0;
    this.size = null;
    this.audioStarted = false;
    this.output = null;
    this.volume = loadSetting('volume', 0.4);
    this.palette = loadSetting('palette', DEFAULT_PALETTE);
    this.brightness = loadSetting('brightness', 1);
    this.viewMode = 'auto';
    this.sampleListeners = [];
    this.statsListeners = [];
    this.roomListeners = [];
    this.lastAnnounce = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.dragging = false;
  }

  get room() {
    return this.history.present;
  }

  // --- start up ---

  async start({ room }) {
    this.history.reset(room ?? makeScene('cathedral'));
    this.bindPointer();
    this.bindKeyboard();
    this.sim.on('samples', (message) => this.onSamples(message));
    this.sim.on('stats', (message) => this.onStats(message));
    this.sim.on('rate-changed', (message) => this.onRateChanged(message));
    this.sim.on('device-lost', (message) => this.fail('The graphics device was lost.', `${message.message} Reload the page to continue. Your room is saved.`));
    this.sim.on('worker-error', (message) => this.fail('The simulation stopped.', message.message));
    this.sim.on('gpu-error', (message) => this.handleGpuError(message.message));
    this.sim.on('blow-up', () => this.toast('The simulation became unstable and was reset. Please report this room.'));

    const channel = new MessageChannel();
    this.output = await createAudioOutput(channel.port1, { gain: this.volume });
    const layout = this.measureLayout();
    const canvas = this.dom.field.transferControlToOffscreen();
    document.addEventListener('visibilitychange', () => this.sim.send('setVisible', { visible: !document.hidden }));
    const result = await this.sim.request(
      'init',
      { canvas, audioPort: channel.port2, room: this.room, layout, visible: !document.hidden },
      [canvas, channel.port2],
    );
    this.rate = result.rate;
    this.benchmark = result;
    await this.refreshSize();
    this.sim.send('setView', {
      mode: this.viewMode,
      palette: this.palette,
      brightness: this.brightness,
      reducedMotion: this.reducedMotion.matches,
    });
    this.reducedMotion.addEventListener('change', (e) => this.sim.send('setView', { reducedMotion: e.matches }));
    this.applyLayout();
    new ResizeObserver(() => this.applyLayout()).observe(this.dom.stage);
    this.notifyRoom();
    this.renderLoop();
    this.dom.boot.classList.add('done');
    setTimeout(() => this.dom.boot.remove(), 700);
    if (!result.confident && !result.doubtful) {
      this.toast(`Your GPU is busy, so Hollow is running at ${result.rate / 1000} kHz. Sound may stutter.`);
    }
  }

  async refreshSize() {
    this.size = await this.sim.request('setRoom', { room: this.room });
  }

  fail(title, detail) {
    const { boot, bootNote } = this.dom;
    if (!boot.isConnected) document.body.append(boot);
    boot.classList.remove('done');
    boot.querySelector('.boot-word').textContent = title;
    boot.querySelector('.boot-word').style.fontSize = '32px';
    bootNote.textContent = detail;
  }

  handleGpuError(message) {
    this.gpuErrors = (this.gpuErrors ?? 0) + 1;
    if (this.gpuErrors === 1) this.toast(`GPU error: ${message.slice(0, 140)}`);
  }

  // --- audio ---

  async ensureAudio() {
    if (this.audioStarted) return;
    this.audioStarted = true;
    await this.output.resume();
  }

  setVolume(value) {
    this.volume = value;
    this.output?.setGain(value);
    saveSetting('volume', value);
  }

  // --- room ---

  // Every change to a room goes through here, so the simulation, undo and autosave can
  // never disagree about what the room is.
  commit(room, { group = null, undoable = true } = {}) {
    if (undoable) this.history.push(room, group);
    else this.history.replace(room);
    this.sim.send('setRoom', { room });
    this.notifyRoom();
    this.overlay.dirty = true;
  }

  // Swaps in a whole different room, with a fresh undo history.
  async loadRoom(room, { keepHistory = false } = {}) {
    if (keepHistory) this.history.push(room);
    else this.history.reset(room);
    this.size = await this.sim.request('loadRoom', { room });
    this.applyLayout();
    this.notifyRoom();
    this.renderPanel();
    this.active?.onGridChange?.();
    this.overlay.dirty = true;
  }

  undo() {
    if (!this.history.canUndo) return;
    const room = this.history.undo();
    this.applyHistory(room);
    this.announce('Undone');
  }

  redo() {
    if (!this.history.canRedo) return;
    const room = this.history.redo();
    this.applyHistory(room);
    this.announce('Redone');
  }

  applyHistory(room) {
    this.sim.send('setRoom', { room });
    this.refreshSizeSoon();
    this.applyLayout();
    this.notifyRoom();
    this.overlay.dirty = true;
  }

  refreshSizeSoon() {
    this.refreshSize().then(() => {
      this.applyLayout();
      this.active?.onGridChange?.();
    }).catch((error) => this.toast(`The room could not be updated: ${error.message}`));
  }

  // A new rate or size means new cell coordinates for anything pointing into the grid.
  gridChanged(size) {
    this.size = size;
    this.applyLayout();
    this.active?.onGridChange?.();
  }

  onRoom(listener) {
    this.roomListeners = [...this.roomListeners, listener];
  }

  notifyRoom() {
    this.dom.roomName.textContent = this.room.name;
    document.title = `${this.room.name} · Hollow`;
    for (const listener of this.roomListeners) listener(this.room);
    this.active?.onRoomChange?.(this.room);
  }

  // --- layout ---

  measureLayout() {
    const rect = this.dom.stage.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    return {
      width: rect.width,
      height: rect.height,
      dpr: this.dpr,
      padding: rect.width < 500 ? 8 : 20,
      inset: this.coveredEdges(rect),
    };
  }

  // How far the floating controls reach into the field from each edge. On a phone they sit
  // beside the field instead, and cover nothing.
  coveredEdges(stage) {
    const { rail, panel } = this.dom;
    const masthead = this.dom.app.querySelector('.masthead');
    const reach = (node, side) => {
      if (!node || node.offsetParent === null || getComputedStyle(node).visibility === 'hidden') return 0;
      const r = node.getBoundingClientRect();
      if (r.right <= stage.left || r.left >= stage.right || r.bottom <= stage.top || r.top >= stage.bottom) return 0;
      if (side === 'left') return r.right - stage.left;
      if (side === 'right') return stage.right - r.left;
      if (side === 'top') return r.bottom - stage.top;
      return stage.bottom - r.top;
    };
    // On a wide screen the welcome's words sit at the left, and the room plays beside them.
    const welcome = document.querySelector('.welcome:not([hidden]):not(.leaving) .welcome-inner');
    const wide = stage.width > 860;
    // On a narrow one they sit at the bottom, and the room plays above them. If the words would
    // leave the room less than 40% of the field, the room plays behind them instead.
    const beside = (extent, total) => (extent < total * 0.6 ? extent : 0);
    return {
      left: Math.max(reach(rail, 'left'), wide && welcome ? beside(reach(welcome, 'left'), stage.width) : 0),
      right: reach(panel, 'right'),
      top: reach(masthead, 'top'),
      bottom: !wide && welcome ? beside(reach(welcome, 'bottom'), stage.height) : 0,
    };
  }

  applyLayout() {
    const layout = this.measureLayout();
    setCanvasSize(this.dom.overlay, layout.width, layout.height);
    this.view = fitView(this.room, layout.width, layout.height, layout.padding, layout.inset);
    this.sim.send('resize', { layout });
    this.overlay.dirty = true;
  }

  // --- workspaces ---

  registerWorkspace(workspace) {
    this.workspaces = [...this.workspaces, workspace];
    const item = el('button', {
      type: 'button',
      title: workspace.label,
      onclick: () => this.openWorkspace(workspace.key),
    }, icon(workspace.key), el('span', { text: workspace.label }));
    workspace.railButton = item;
    this.dom.rail.append(item);
    if (GROUP_ENDS.has(workspace.key)) this.dom.rail.append(el('span', { class: 'rail-gap', 'aria-hidden': 'true' }));
  }

  openWorkspace(key) {
    const next = this.workspaces.find((w) => w.key === key);
    if (!next) return;
    if (this.active === next) {
      next.onReopen?.();
      return;
    }
    this.active?.onHide?.();
    this.active = next;
    for (const w of this.workspaces) {
      if (w === next) w.railButton.setAttribute('aria-current', 'true');
      else w.railButton.removeAttribute('aria-current');
    }
    this.renderPanel();
    this.dom.panel.scrollTop = 0;
    next.onShow?.();
    this.applyLayout();
  }

  // Rebuilds the active workspace's controls, for when the room itself has been replaced.
  renderPanel() {
    const { active } = this;
    const content = active?.render ? [active.render()].flat().filter(Boolean) : [];
    this.dom.panel.replaceChildren(...content);
  }

  setTool(tool) {
    this.tool?.onDeactivate?.();
    this.tool = tool;
    this.tool?.onActivate?.();
    this.dom.overlay.style.cursor = tool?.cursor ?? 'crosshair';
    this.overlay.dirty = true;
  }

  // --- pointer and keyboard ---

  roomPoint(event) {
    const rect = this.dom.overlay.getBoundingClientRect();
    return screenToRoom(this.view, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  bindPointer() {
    const { overlay } = this.dom;
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      overlay.setPointerCapture(event.pointerId);
      this.ensureAudio();
      this.dragging = true;
      this.cursor = null;
      this.tool?.down?.(this.roomPoint(event), event);
      this.overlay.dirty = true;
    });
    overlay.addEventListener('pointermove', (event) => {
      this.hover = this.roomPoint(event);
      this.tool?.move?.(this.hover, event, this.dragging);
      if (this.tool?.wantsHover || this.dragging) this.overlay.dirty = true;
    });
    const end = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.tool?.up?.(this.roomPoint(event), event);
      this.overlay.dirty = true;
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
    overlay.addEventListener('dblclick', (event) => this.tool?.doubleClick?.(this.roomPoint(event), event));
  }

  // Arrow keys drive a cursor over the room, so everything a pointer can do here can also be
  // done from the keyboard. Enter stands in for a press and release at that spot.
  bindKeyboard() {
    const { overlay } = this.dom;
    overlay.addEventListener('keydown', (event) => {
      const moves = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      };
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        const room = this.room;
        const start = this.cursor ?? { x: room.width / 2, y: room.height / 2 };
        const step = event.shiftKey ? CURSOR_STEP * 5 : CURSOR_STEP;
        this.cursor = clampToRoom(room, { x: start.x + move[0] * step, y: start.y + move[1] * step });
        this.tool?.move?.(this.cursor, event, this.keyDragging === true);
        this.overlay.dirty = true;
      } else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.shiftKey) {
        event.preventDefault();
        const room = this.room;
        const at = this.cursor ?? { x: room.width / 2, y: room.height / 2 };
        this.cursor = at;
        this.ensureAudio();
        if (this.tool?.keyboardAct) {
          this.tool.keyboardAct(at);
        } else {
          this.tool?.down?.(at, event);
          this.tool?.up?.(at, event);
        }
        this.overlay.dirty = true;
      }
    });
    overlay.addEventListener('blur', () => {
      this.cursor = null;
      this.overlay.dirty = true;
    });
  }

  isInside(point) {
    return insideRoom(this.room, point);
  }

  // --- status ---

  onSamples(message) {
    for (const listener of this.sampleListeners) listener(message);
  }

  addSampleListener(listener) {
    this.sampleListeners = [...this.sampleListeners, listener];
    return () => {
      this.sampleListeners = this.sampleListeners.filter((l) => l !== listener);
    };
  }

  addStatsListener(listener) {
    this.statsListeners = [...this.statsListeners, listener];
    return () => {
      this.statsListeners = this.statsListeners.filter((l) => l !== listener);
    };
  }

  onStats(message) {
    this.stats = message.stats;
    this.level = message.level;
    this.rate = message.stats.rate;
    for (const listener of this.statsListeners) listener(message);
  }

  onRateChanged(message) {
    const changed = message.rate !== this.rate;
    this.rate = message.rate;
    if (message.reason !== 'measured') {
      this.toast(`Your GPU fell behind, so the simulation dropped to ${message.rate / 1000} kHz.`);
    } else if (changed) {
      this.toast(`Measured your GPU: ${message.rate / 1000} kHz.`);
    }
    this.refreshSizeSoon();
  }

  setHint(text) {
    this.dom.hint.textContent = text;
  }

  setTimeBadge(text, kind = '') {
    const { timeBadge } = this.dom;
    timeBadge.hidden = !text;
    timeBadge.textContent = text ?? '';
    timeBadge.dataset.kind = kind;
  }

  toast(text) {
    const { toast } = this.dom;
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  announce(text, { throttled = false } = {}) {
    const now = performance.now();
    if (throttled && now - this.lastAnnounce < STATUS_ANNOUNCE_MS) return;
    this.lastAnnounce = now;
    this.dom.announcer.textContent = text;
  }

  openSheet(build) {
    const { sheet } = this.dom;
    const close = () => sheet.close();
    sheet.replaceChildren(
      el('button', { type: 'button', class: 'btn close', text: 'Close', onclick: close }),
      ...[build(close)].flat().filter(Boolean),
    );
    sheet.showModal();
  }

  // --- drawing ---

  renderLoop() {
    const tick = () => {
      if (this.overlay.dirty || this.overlay.marks.length || this.alwaysDraw) {
        this.overlay.dirty = false;
        this.overlay.draw(this.room, this.view, this.dpr, this.cursor);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
