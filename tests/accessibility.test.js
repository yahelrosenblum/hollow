// Colours are checked by calculation, including how they look to people with colour-vision
// deficiencies, rather than by whoever happens to be looking at the screen.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PALETTES } from '../src/render/palettes.js';
import { isTypingTarget, keyName } from '../src/ui/shortcuts.js';

// Machado, Oliveira and Fernandes (2009), severity 1.0.
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function toLinear(rgb) {
  return rgb.map(linear);
}

function apply(matrix, rgb) {
  return matrix.map((row) => Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
}

function luminance(lin) {
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const la = luminance(a) + 0.05;
  const lb = luminance(b) + 0.05;
  return Math.max(la, lb) / Math.min(la, lb);
}

function toLab(lin) {
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a, b) {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const css = readFileSync(new URL('../styles/main.css', import.meta.url), 'utf8');

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing token ${name}`);
  return toLinear(hexToRgb(match[1]));
}

test('measurement text meets WCAG AA contrast on every surface', () => {
  for (const surface of ['ink', 'ink-raised', 'ink-sunk']) {
    for (const text of ['paper', 'paper-dim', 'paper-faint', 'warm', 'cool', 'alert', 'good']) {
      const ratio = contrast(token(text), token(surface));
      assert.ok(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
  }
});

test('positive and negative pressure stay distinct in every palette, under every deficiency', () => {
  for (const palette of Object.values(PALETTES)) {
    const positive = toLinear(palette.positive);
    const negative = toLinear(palette.negative);
    const views = {
      normal: [positive, negative],
      ...Object.fromEntries(Object.entries(CVD).map(([k, m]) => [k, [apply(m, positive), apply(m, negative)]])),
    };
    for (const [name, [a, b]] of Object.entries(views)) {
      const difference = deltaE(a, b);
      assert.ok(difference >= 30, `${palette.key} under ${name}: difference ${difference.toFixed(1)}`);
    }
  }
});

test('positive and negative pressure both stand out from the background', () => {
  for (const palette of Object.values(PALETTES)) {
    if (palette.key === 'luminance') continue;
    const ink = toLinear(palette.ink);
    for (const tint of [palette.positive, palette.negative]) {
      for (const matrix of [null, ...Object.values(CVD)]) {
        const a = matrix ? apply(matrix, toLinear(tint)) : toLinear(tint);
        const b = matrix ? apply(matrix, ink) : ink;
        assert.ok(contrast(a, b) >= 3, `${palette.key}: contrast ${contrast(a, b).toFixed(2)}`);
      }
    }
  }
});

test('the brightness-only palette needs no colour vision at all', () => {
  const p = PALETTES.luminance;
  for (const c of [p.positive, p.negative, p.ink]) {
    assert.ok(Math.abs(c[0] - c[1]) < 0.001 && Math.abs(c[1] - c[2]) < 0.001);
  }
  const lum = (c) => luminance(toLinear(c));
  assert.ok(lum(p.positive) > lum(p.ink));
  assert.ok(lum(p.ink) > lum(p.negative));
});

test('reduced motion is honoured in the stylesheet', () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('focus is always visible', () => {
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css.replace(/\.panel:focus \{ outline: none; \}/, ''), /:focus \{ outline: none/);
});

test('shortcuts never fire while typing', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ isContentEditable: true, tagName: 'DIV' }), true);
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('key names come out the way the shortcut table writes them', () => {
  assert.equal(keyName({ key: 'z', ctrlKey: true }), 'Ctrl+Z');
  assert.equal(keyName({ key: 'z', metaKey: true }), 'Ctrl+Z');
  // Regression: this used to come out as Ctrl+Z, so the redo shortcut undid instead.
  assert.equal(keyName({ key: 'Z', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z');
  assert.equal(keyName({ key: ' ' }), 'Space');
  assert.equal(keyName({ key: 'ArrowLeft', altKey: true }), 'Alt+ArrowLeft');
  assert.equal(keyName({ key: '?', shiftKey: true }), '?');
});
