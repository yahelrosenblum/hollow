// The numerical scheme, in one place. The WGSL solver and the CPU reference both
// read their constants from here, so they cannot disagree about the physics.
//
// Discrete operator, for an open cell i:
//   L_i = sum over open neighbours j of  w_ij * K_ij * (u_j - u_i)
//   u+_i = u-_i + (2 (u_i - u-_i) + LAMBDA2 * m_i * L_i) / (1 + g_i)
//
// w_ij is the classic isotropic 9-point Laplacian: 2/3 axial, 1/6 diagonal.
// See docs/DECISIONS.md for why LAMBDA2 sits just under the 3/4 stability limit.

export const C_AIR = 343; // m/s
export const LAMBDA2_LIMIT = 0.75;
export const LAMBDA2 = 0.74;

export const W_AXIAL = 2 / 3;
export const W_DIAG = 1 / 6;

// Neighbour order is shared with the shader: bit n of a cell's flags means
// "the edge to NEIGHBOURS[n] is open".
export const NEIGHBOURS = Object.freeze([
  [1, 0, W_AXIAL], [-1, 0, W_AXIAL], [0, -1, W_AXIAL], [0, 1, W_AXIAL],
  [1, -1, W_DIAG], [-1, -1, W_DIAG], [1, 1, W_DIAG], [-1, 1, W_DIAG],
]);

export const MASK_ALL_OPEN = 0xff;
export const FLAG_SOLID = 1 << 8;
export const FLAG_SLOW = 1 << 9;
export const FLAG_REED = 1 << 10;

// Beside a flat rigid wall, a diagonal edge that would enter the wall reflects onto the
// axial edge running along the wall, as the mirror image demands. Two bits per axial
// neighbour count those reflections (0, 1 or 2), each worth W_DIAG. Without this, a wave
// grazing a wall sees 5/6 of the correct conductance and scatters. See docs/DECISIONS.md.
export const MIRROR_SHIFT = 11;
export const MIRROR_MASK = 3;

export function axialWeight(flags, n) {
  return W_AXIAL + W_DIAG * ((flags >>> (MIRROR_SHIFT + 2 * n)) & MIRROR_MASK);
}

export function edgeWeight(flags, n) {
  return n < 4 ? axialWeight(flags, n) : W_DIAG;
}

// Largest eigenvalue of the full-grid operator: 8 - 8a with a = 1/3.
export const MAX_OPERATOR_EIGENVALUE = 16 / 3;

export function timeStepFor(rate) {
  return 1 / rate;
}

// Grid spacing in metres for a simulation rate: lambda = c * dt / dx.
export function cellSizeFor(rate, lambda2 = LAMBDA2) {
  return (C_AIR * timeStepFor(rate)) / Math.sqrt(lambda2);
}

// Step coefficients for a plain air cell. The update is always written in differences:
//   u+ = u- + (2 (u - u-) + axial * (sumA - 4u) + diagonal * (sumD - 4u)) / (1 + g)
// A constant field then stays exactly constant at any rounding. The expanded form, whose
// 32-bit coefficients do not sum to exactly 2, grows that mode. See docs/DECISIONS.md.
export function fastCoefficients(lambda2 = LAMBDA2) {
  return {
    axial: W_AXIAL * lambda2,
    diagonal: W_DIAG * lambda2,
  };
}

// Conductance of the edge between two cells: harmonic mean of their inverse densities.
export function edgeConductance(ki, kj) {
  if (ki === kj) return ki;
  return (2 * ki * kj) / (ki + kj);
}

export function pressureReflection(z1, z2) {
  return (z2 - z1) / (z2 + z1);
}

export function pressureTransmission(z1, z2) {
  return (2 * z2) / (z2 + z1);
}

// Normal-incidence reflection of a locally reacting wall with specific admittance beta.
export function wallReflection(beta) {
  return (1 - beta) / (1 + beta);
}

// Pressure transmission of a limp mass sheet of surface density M (kg/m^2).
export function massLawTransmission(frequency, surfaceDensity, rho0 = 1.2, c = C_AIR) {
  const x = (2 * Math.PI * frequency * surfaceDensity) / (2 * rho0 * c);
  return 1 / Math.sqrt(1 + x * x);
}
