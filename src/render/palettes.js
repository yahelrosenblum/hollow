// Field colour maps. Positive pressure, negative pressure and accumulated energy must stay
// distinguishable for every viewer, so each palette is checked by tests/palettes.test.js
// under simulated colour-vision deficiency, not just by eye.

const hex = (value) => [
  ((value >> 16) & 255) / 255,
  ((value >> 8) & 255) / 255,
  (value & 255) / 255,
];

export const PALETTES = Object.freeze({
  drafting: {
    key: 'drafting',
    label: 'Warm and cool light',
    note: 'Gold for high pressure, cyan for low.',
    ink: hex(0x05080e),
    positive: hex(0xffa940),
    negative: hex(0x2fb8ff),
    energy: hex(0xb7a6ff),
    wall: hex(0x8ea4bd),
    light: hex(0xfff3dc),
  },
  deuteranopia: {
    key: 'deuteranopia',
    label: 'Colour-blind safe',
    note: 'Yellow and blue, separated for red-green colour blindness.',
    ink: hex(0x05080e),
    positive: hex(0xf0d04a),
    negative: hex(0x3f7fe0),
    energy: hex(0xe6e6e6),
    wall: hex(0x9a9a9a),
    light: hex(0xffffff),
  },
  luminance: {
    key: 'luminance',
    label: 'Brightness only',
    note: 'No colour at all: high pressure is light, low pressure is dark.',
    ink: hex(0x3a3a3a),
    positive: hex(0xffffff),
    negative: hex(0x000000),
    energy: hex(0xffffff),
    wall: hex(0x888888),
    light: hex(0xffffff),
  },
});

export const DEFAULT_PALETTE = 'drafting';
