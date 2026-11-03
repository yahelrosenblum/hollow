// Build workspace: the acoustic architecture editor.

import { button, el, select, slider } from '../../app/dom.js';
import {
  DEFAULT_WALL_THICKNESS, duplicateObject, doorOpenness, removeObjects, rotateObject,
  scaleObject, translateObject, updateObject,
} from '../../scene/room.js';
import { MATERIALS } from '../../sim/materials.js';
import { validateRoom } from '../../scene/schema.js';
import {
  CurveTool, FreehandTool, SelectTool, ShapeTool, SpanTool, WallTool,
} from './tools.js';

const DOOR_SWING_MS = 420;
const NUDGE_METRES = 0.05;

const DRAWABLE = MATERIALS.filter((m) => ['stone', 'wood', 'foam', 'heavy-gas', 'reed', 'mirror'].includes(m.key));

export const TOOL_LIST = Object.freeze([
  { key: 'select', label: 'Select', shortcut: 'V' },
  { key: 'wall', label: 'Wall', shortcut: 'W' },
  { key: 'curve', label: 'Curve', shortcut: 'C' },
  { key: 'freehand', label: 'Draw', shortcut: 'F' },
  { key: 'rect', label: 'Box', shortcut: 'R' },
  { key: 'ellipse', label: 'Ellipse', shortcut: 'E' },
  { key: 'door', label: 'Door', shortcut: 'D' },
  { key: 'window', label: 'Window', shortcut: 'N' },
  { key: 'opening', label: 'Opening', shortcut: 'O' },
  { key: 'measure', label: 'Measure', shortcut: 'M' },
]);

const HINTS = {
  select: 'Click to select. Drag to move. Use the corner handle to resize and the top handle to rotate.',
  wall: 'Click to place points, then double-click or press Shift+Enter to finish. Shift while drawing keeps to 15° steps.',
  curve: 'Drag from end to end, then click to set how far it bows.',
  freehand: 'Draw with the pointer. The stroke becomes a wall.',
  rect: 'Drag out a box. Tick Hollow for walls only.',
  ellipse: 'Drag out an ellipse. Tick Hollow for walls only.',
  door: 'Drag along the doorway, from the hinge. Doors really move: shut, they block sound.',
  window: 'Drag along the wall. Closed glass passes lows and stops highs, like the real thing.',
  opening: 'Drag across a wall to cut a passage through it.',
  measure: 'Drag between any two points.',
};

export function buildWorkspace(app) {
  const build = {
    app,
    settings: {
      material: 'stone',
      thickness: DEFAULT_WALL_THICKNESS,
      snap: true,
      gridStep: 0.25,
      hollow: false,
    },
    selectedId: null,
    tools: null,
    toolKey: 'select',
    removeLayer: null,
    selectedObject() {
      return app.room.objects.find((o) => o.id === build.selectedId) ?? null;
    },
    select(id) {
      build.selectedId = id;
      refreshPanel();
      app.overlay.dirty = true;
    },
    refreshSelection: () => refreshInspector(),
  };
  build.tools = {
    select: new SelectTool(build),
    wall: new WallTool(build),
    curve: new CurveTool(build),
    freehand: new FreehandTool(build),
    rect: new ShapeTool(build, 'rect'),
    ellipse: new ShapeTool(build, 'ellipse'),
    door: new SpanTool(build, 'door'),
    window: new SpanTool(build, 'window'),
    opening: new SpanTool(build, 'opening'),
    measure: new SpanTool(build, 'measure'),
  };

  let toolButtons = {};
  let hintLine;
  let inspector;
  let objectList;

  function chooseTool(key) {
    build.toolKey = key;
    app.setTool(build.tools[key]);
    for (const [k, node] of Object.entries(toolButtons)) node.setAttribute('aria-pressed', String(k === key));
    if (hintLine) hintLine.textContent = HINTS[key];
    app.announce(`${TOOL_LIST.find((t) => t.key === key).label} tool`);
  }

  // A door moves through its positions while the solver runs, so sound changes as it swings.
  function swingDoor(object) {
    const from = doorOpenness(object);
    const to = from > 0.5 ? 0 : 1;
    const started = performance.now();
    // Every frame of the swing is one undo step, which undoes back to where the door began.
    const group = `door-${started}`;
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / DOOR_SWING_MS);
      const eased = t * t * (3 - 2 * t);
      const open = from + (to - from) * eased;
      app.commit(updateObject(app.room, object.id, { open }), { group });
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        app.commit(updateObject(app.room, object.id, { open: to }), { group });
        app.announce(to ? 'Door open' : 'Door shut');
        refreshInspector();
      }
    };
    requestAnimationFrame(step);
  }

  function deleteSelected() {
    if (!build.selectedId) return;
    app.commit(removeObjects(app.room, [build.selectedId]));
    build.select(null);
    app.announce('Deleted');
  }

  function duplicateSelected() {
    const object = build.selectedObject();
    if (!object) return;
    const copy = duplicateObject(object);
    app.commit({ ...app.room, objects: [...app.room.objects, copy] });
    build.select(copy.id);
    app.announce('Duplicated');
  }

  // Leaves the inspector alone: rebuilding it would destroy the slider being dragged. Actions
  // that change what the inspector shows ask for a refresh themselves.
  function transformSelected(next, group) {
    app.commit(updateObject(app.room, build.selectedId, next), { group });
    renderObjectList();
  }

  function nudge(dx, dy) {
    const object = build.selectedObject();
    if (object) transformSelected(translateObject(object, dx * NUDGE_METRES, dy * NUDGE_METRES), 'nudge');
  }

  function rotateSelected(angle) {
    const object = build.selectedObject();
    if (object) transformSelected(rotateObject(object, angle), 'rotate');
  }

  // A room the editor makes must be a room Hollow can open again, so a shape can't be scaled
  // past what a saved file is allowed to contain.
  function scaleSelected(factor) {
    const object = build.selectedObject();
    if (!object) return;
    const scaled = scaleObject(object, factor);
    if (!validateRoom(updateObject(app.room, object.id, scaled)).ok) {
      app.toast('That is as large as this shape can go.');
      return;
    }
    transformSelected(scaled, 'scale');
  }

  function materialField(object) {
    if (!('material' in object) || object.type === 'door') return null;
    return select({
      label: 'Material',
      value: object.material,
      options: DRAWABLE.map((m) => ({ value: m.key, label: m.label })),
      onchange: (material) => transformSelected({ ...object, material }),
    }).row;
  }

  function thicknessField(object) {
    const key = object.type === 'opening' ? 'width' : 'thickness';
    if (!(key in object) || object.type === 'window') return null;
    return slider({
      label: object.type === 'opening' ? 'Width' : 'Thickness',
      min: 0.02,
      max: 1,
      step: 0.01,
      value: object[key],
      format: (v) => `${v.toFixed(2)} m`,
      oninput: (v) => transformSelected({ ...build.selectedObject(), [key]: v }, `thick-${object.id}`),
    }).row;
  }

  function renderInspector() {
    const object = build.selectedObject();
    if (!object) return [el('p', { class: 'note', text: 'Nothing selected.' })];
    const actions = el(
      'div',
      { class: 'btn-grid' },
      button('Duplicate', duplicateSelected),
      button('Delete', deleteSelected),
      button('Rotate 15°', () => rotateSelected(Math.PI / 12)),
      button('Bigger', () => scaleSelected(1.1)),
      button('Smaller', () => scaleSelected(1 / 1.1)),
    );
    const specific = [];
    if (object.type === 'door') {
      specific.push(button(doorOpenness(object) > 0.5 ? 'Shut the door' : 'Open the door', () => swingDoor(object), { class: 'btn wide primary' }));
    }
    if (object.type === 'window') {
      specific.push(button(object.open ? 'Close the window' : 'Open the window', () => {
        transformSelected({ ...object, open: !object.open });
        refreshInspector();
      }, { class: 'btn wide primary' }));
    }
    if (object.type === 'rect' || object.type === 'ellipse') {
      const checkbox = el('input', {
        type: 'checkbox',
        checked: object.ring !== undefined,
        onchange: (event) => {
          const { ring: _drop, ...rest } = object;
          transformSelected(event.target.checked ? { ...rest, ring: build.settings.thickness } : rest);
          refreshInspector();
        },
      });
      specific.push(el('label', { class: 'note', style: 'display:flex;gap:8px;align-items:center' }, checkbox, 'Hollow: walls only'));
    }
    return [
      el('p', { class: 'note', text: `Selected: ${object.type}` }),
      ...specific,
      materialField(object),
      thicknessField(object),
      actions,
    ].filter(Boolean);
  }

  function refreshInspector() {
    if (inspector) inspector.replaceChildren(...renderInspector());
    renderObjectList();
  }

  function renderObjectList() {
    if (!objectList) return;
    const items = app.room.objects.map((o, n) => el(
      'li',
      {},
      el(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          style: `width:100%;text-align:left;border-bottom:none${o.id === build.selectedId ? ';color:var(--paper)' : ''}`,
          'aria-current': o.id === build.selectedId ? 'true' : undefined,
          text: `${n + 1}. ${o.type}${o.material ? `, ${o.material}` : ''}`,
          disabled: o.locked === true,
          title: o.locked ? 'Part of the challenge, so it stays where it is' : undefined,
          onclick: () => {
            chooseTool('select');
            build.select(o.id);
          },
        },
      ),
    ));
    objectList.replaceChildren(...items);
  }

  function refreshPanel() {
    refreshInspector();
  }

  function drawLayer(ctx, view) {
    app.tool?.draw?.(ctx, view);
    if (app.tool !== build.tools.select && build.toolKey !== 'select') build.tools.select.draw(ctx, view);
    const measure = build.tools.measure;
    if (measure.stored && app.tool !== measure) measure.draw(ctx, view);
  }

  function render() {
    toolButtons = {};
    const toolGrid = el('div', { class: 'btn-grid', role: 'group', 'aria-label': 'Drawing tools' }, TOOL_LIST.map((t) => {
      const node = button(t.label, () => chooseTool(t.key), {
        title: `${t.label} (${t.shortcut})`,
        'aria-pressed': String(t.key === build.toolKey),
        'aria-keyshortcuts': t.shortcut.toLowerCase(),
      });
      toolButtons[t.key] = node;
      return node;
    }));
    hintLine = el('p', { class: 'note', text: HINTS[build.toolKey] });
    const material = select({
      label: 'Material',
      value: build.settings.material,
      options: DRAWABLE.map((m) => ({ value: m.key, label: m.label })),
      onchange: (value) => { build.settings.material = value; },
    });
    const thickness = slider({
      label: 'Thickness',
      min: 0.04,
      max: 0.8,
      step: 0.01,
      value: build.settings.thickness,
      format: (v) => `${v.toFixed(2)} m`,
      oninput: (v) => { build.settings.thickness = v; },
    });
    const gridStep = select({
      label: 'Grid',
      value: String(build.settings.gridStep),
      options: [
        { value: '0.1', label: '10 cm' },
        { value: '0.25', label: '25 cm' },
        { value: '0.5', label: '50 cm' },
        { value: '1', label: '1 m' },
      ],
      onchange: (value) => {
        build.settings.gridStep = Number(value);
        app.overlay.gridStep = Number(value);
        app.overlay.dirty = true;
      },
    });
    const snap = el('input', {
      type: 'checkbox',
      checked: build.settings.snap,
      onchange: (event) => { build.settings.snap = event.target.checked; },
    });
    const hollow = el('input', {
      type: 'checkbox',
      checked: build.settings.hollow,
      onchange: (event) => { build.settings.hollow = event.target.checked; },
    });
    inspector = el('div', {}, ...renderInspector());
    objectList = el('ul', { class: 'list' });
    renderObjectList();
    return [
      el('h2', { text: 'Build' }),
      el('p', { class: 'placard', text: 'Everything you draw is in the solver the moment you draw it, even while sound is ringing.' }),
      toolGrid,
      hintLine,
      el('div', { class: 'btn-row' }, build.undoButton(), build.redoButton()),
      el('h3', { text: 'New objects' }),
      material.row,
      thickness.row,
      gridStep.row,
      el('label', { class: 'note', style: 'display:flex;gap:8px;align-items:center' }, snap, 'Snap to grid and wall ends'),
      el('label', { class: 'note', style: 'display:flex;gap:8px;align-items:center' }, hollow, 'Hollow: boxes and ellipses are walls only'),
      el('h3', { text: 'Selected' }),
      inspector,
      el('h3', { text: 'Everything in this room' }),
      objectList,
    ];
  }

  build.undoButton = () => button('Undo', () => app.undo(), { title: 'Undo (Ctrl+Z)' });
  build.redoButton = () => button('Redo', () => app.redo(), { title: 'Redo (Ctrl+Y)' });

  return {
    key: 'build',
    label: 'Build',
    render,
    onShow() {
      app.overlay.showGrid = true;
      app.overlay.gridStep = build.settings.gridStep;
      build.removeLayer = app.overlay.addLayer(drawLayer);
      chooseTool(build.toolKey);
      app.setHint('');
    },
    onHide() {
      app.overlay.showGrid = false;
      build.tools.measure.stored = null;
      build.removeLayer?.();
      app.overlay.dirty = true;
    },
    onRoomChange() {
      if (build.selectedId && !build.selectedObject()) build.selectedId = null;
      renderObjectList();
    },
    chooseTool,
    deleteSelected,
    duplicateSelected,
    nudge,
    rotateSelected,
    scaleSelected,
    finishPath() {
      app.tool?.finish?.();
    },
    cancelTool() {
      app.tool?.cancel?.();
      app.overlay.dirty = true;
    },
    build,
  };
}
