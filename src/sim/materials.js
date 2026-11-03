// Materials are physical parameters, never audio effects. Each one only changes
// coefficients in the wave equation.
//
//  wall   rigid-backed boundary with specific admittance `beta` (0 = perfect reflector)
//  fluid  a medium with relative density `rho`, relative sound speed `c`,
//         pressure damping `sigma` (1/s) and viscous `diffusivity` (m^2/s).
//         Viscous loss acts on velocity, so it grows with frequency.
//  sheet  a one-cell limp partition of surface density `surfaceDensity` (kg/m^2)

export const AIR = 0;
export const STONE = 1;
export const WOOD = 2;
export const FOAM = 3;
export const GLASS = 4;
export const HEAVY_GAS = 5;
export const REED = 6;
export const MIRROR = 7;
export const HEAD = 8;
export const DOOR_LEAF = 9;

export const RHO_AIR = 1.2; // kg/m^3

const TABLE = [
  { id: AIR, key: 'air', label: 'Air', kind: 'fluid', rho: 1, c: 1, sigma: 0 },
  { id: STONE, key: 'stone', label: 'Stone', kind: 'wall', beta: 0.02 },
  { id: WOOD, key: 'wood', label: 'Wood', kind: 'wall', beta: 0.12 },
  { id: FOAM, key: 'foam', label: 'Foam', kind: 'fluid', rho: 1.2, c: 0.85, sigma: 80, diffusivity: 0.7 },
  { id: GLASS, key: 'glass', label: 'Glass', kind: 'sheet', surfaceDensity: 5 },
  // Sulphur hexafluoride: the classic heavy gas used in acoustic lens demonstrations.
  { id: HEAVY_GAS, key: 'heavy-gas', label: 'Heavy gas', kind: 'fluid', rho: 5.1, c: 0.44, sigma: 0 },
  // The loss stands in for a real reed's mass. Without it the reed amplifies high modes trapped
  // across the pipe as readily as the note, and which one wins comes down to chance. Above
  // 11 kHz the stability limit on viscous loss caps it, which compile.js applies.
  { id: REED, key: 'reed', label: 'Reed', kind: 'fluid', rho: 1, c: 1, sigma: 0, diffusivity: 0.07, reed: true },
  // A perfect reflector. Only lossless scenes use it, because time reversal needs zero loss.
  { id: MIRROR, key: 'mirror', label: 'Perfect wall', kind: 'wall', beta: 0 },
  // The listener's head, which is a real obstacle in the grid. Sound bends around it.
  { id: HEAD, key: 'head', label: 'Your head', kind: 'wall', beta: 0.3 },
  // A door is a heavy sheet: shut, it passes lows and stops highs, as a real one does.
  { id: DOOR_LEAF, key: 'door-leaf', label: 'Door', kind: 'sheet', surfaceDensity: 15 },
];

export const MATERIALS = Object.freeze(TABLE.map((m) => Object.freeze(m)));

export function isWall(id) {
  return MATERIALS[id].kind === 'wall';
}
