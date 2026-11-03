// A very small DOM helper. All text goes through textContent, so nothing from a loaded room
// file or a share link can ever become markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function button(label, onclick, props = {}) {
  return el('button', { type: 'button', class: 'btn', text: label, onclick, ...props });
}

// A labelled slider with a live value readout.
export function slider({ label, min, max, step = 1, value, format = String, oninput, id }) {
  const inputId = id ?? `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
  const output = el('output', { for: inputId, text: format(value) });
  const input = el('input', {
    type: 'range',
    id: inputId,
    min,
    max,
    step,
    value,
    oninput: (event) => {
      const v = Number(event.target.value);
      output.textContent = format(v);
      oninput(v);
    },
  });
  input.setAttribute('aria-label', label);
  return {
    row: el('div', { class: 'field-row' }, el('label', { htmlFor: inputId, text: label }), input, output),
    input,
    output,
    set(v) {
      input.value = v;
      output.textContent = format(v);
    },
  };
}

export function select({ label, options, value, onchange }) {
  const id = `s-${Math.random().toString(36).slice(2, 8)}`;
  const node = el(
    'select',
    { id, onchange: (event) => onchange(event.target.value) },
    options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value })),
  );
  return {
    row: el('div', { class: 'field-row' }, el('label', { htmlFor: id, text: label }), node),
    input: node,
  };
}

export function metrics(rows) {
  const dl = el('dl', { class: 'metrics' });
  const cells = {};
  for (const { key, label, big } of rows) {
    const dd = el('dd', { class: big ? 'big' : undefined, text: '–' });
    cells[key] = dd;
    dl.append(el('dt', { text: label }), dd);
  }
  return { node: dl, cells };
}

export function setCanvasSize(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

// Storage can throw or be empty in private windows and previews. Settings are only ever a
// convenience, so failures here are deliberately harmless.
export function loadSetting(key, fallback) {
  try {
    const stored = localStorage.getItem(`hollow.${key}`);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`hollow.${key}`, JSON.stringify(value));
  } catch {
    // Nothing depends on this having worked.
  }
}
