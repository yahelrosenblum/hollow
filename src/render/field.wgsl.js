// The field drawn as light. The scene pass turns solver data into light: pressure glows warm or
// cool, accumulated energy is a faint haze, and walls catch light only where the field beside
// them is actually moving. Nothing is drawn that isn't in the data. The post passes then do
// what a camera would: bloom around the brightest light, a filmic curve, a vignette and grain.

export const SCENE_WGSL = /* wgsl */ `
struct View {
  canvas: vec2f,
  origin: vec2f,
  pixelsPerCell: f32,
  frameBase: u32,
  nx: u32,
  ny: u32,
  pressureGain: f32,
  energyGain: f32,
  energyMix: f32,
  pressureMix: f32,
  ink: vec3f, wipeX: f32,
  positive: vec3f, wipeBase: u32,
  negative: vec3f, _p2: f32,
  energyTint: vec3f, _p3: f32,
  wall: vec3f, _p4: f32,
  light: vec3f, surface: f32,
};

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> frames: array<f32>;
@group(0) @binding(2) var<storage, read> energy: array<f32>;
@group(0) @binding(3) var<storage, read> flags: array<u32>;

const SOLID: u32 = 256u;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn cellIndex(x: i32, y: i32) -> u32 {
  let cx = clamp(x, 0, i32(view.nx) - 1);
  let cy = clamp(y, 0, i32(view.ny) - 1);
  return u32(cy) * view.nx + u32(cx);
}

var<private> activeBase: u32;

fn pressureAt(x: i32, y: i32) -> f32 {
  return frames[activeBase + cellIndex(x, y)];
}

fn isSolid(x: i32, y: i32) -> bool {
  return (flags[cellIndex(x, y)] & SOLID) != 0u;
}

fn tone(value: f32) -> f32 {
  // A soft shoulder, so a loud clap and a quiet tail are both legible.
  return value / (1.0 + abs(value));
}

// Light from pressure: faint where the field barely moves, white-hot at a strong wavefront. The
// curve is steep on purpose: a dying echo fills the room at low level, and drawn linearly it
// would bury the wavefronts in speckle.
fn glow(shown: f32) -> vec3f {
  let a = abs(shown);
  let tint = select(view.negative, view.positive, shown > 0.0);
  let a2 = a * a;
  let core = a2 * a2;
  return tint * (a2 * 0.9 + core * 3.2) + view.light * core * a2 * 1.8;
}

fn wallLight(position: vec2f, cell: vec2f) -> vec3f {
  let cx = i32(round(cell.x));
  let cy = i32(round(cell.y));
  // The field beside a wall, at its strongest. Solid cells hold no pressure, so a wall deep
  // inside stays dark and only its faces catch the light.
  var hit = 0.0;
  var edge = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if ((dx != 0 || dy != 0) && !isSolid(cx + dx, cy + dy)) {
        edge = 1.0;
        let p = pressureAt(cx + dx, cy + dy);
        if (abs(p) > abs(hit)) { hit = p; }
      }
    }
  }
  // Dark glass, with the faint diagonal hatch architects use for cut walls.
  let hatch = fract((position.x - position.y) / 9.0);
  let line = smoothstep(0.0, 0.08, hatch) * (1.0 - smoothstep(0.08, 0.2, hatch));
  var colour = view.wall * (0.03 + 0.035 * line);
  let shown = tone(hit * view.pressureGain);
  let tint = select(view.negative, view.positive, shown > 0.0);
  colour += edge * (view.wall * 0.09 + tint * abs(shown) * 2.2 * max(view.pressureMix, 0.35));
  return colour;
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let cell = (position.xy - view.origin) / view.pixelsPerCell;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= f32(view.nx) - 1.0 || cell.y >= f32(view.ny) - 1.0) {
    return vec4f(view.ink * 0.35, 1.0);
  }
  // Original versus reversed: left of the wipe is one stored moment, right is the other.
  let inWipe = view.wipeX >= 0.0 && position.x > view.wipeX;
  activeBase = select(view.frameBase, view.wipeBase, inWipe);
  if (view.wipeX >= 0.0 && abs(position.x - view.wipeX) < 1.0) {
    return vec4f(view.light * 1.5, 1.0);
  }
  let base = floor(cell);
  let f = cell - base;
  let x = i32(base.x);
  let y = i32(base.y);

  if (isSolid(i32(round(cell.x)), i32(round(cell.y)))) {
    return vec4f(wallLight(position.xy, cell), 1.0);
  }

  let p00 = pressureAt(x, y);
  let p10 = pressureAt(x + 1, y);
  let p01 = pressureAt(x, y + 1);
  let p11 = pressureAt(x + 1, y + 1);
  let pressure = mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);

  // Central differences at the four corners, blended, so highlights have no facets.
  let g00 = vec2f(p10 - pressureAt(x - 1, y), p01 - pressureAt(x, y - 1));
  let g10 = vec2f(pressureAt(x + 2, y) - p00, p11 - pressureAt(x + 1, y - 1));
  let g01 = vec2f(p11 - pressureAt(x - 1, y + 1), pressureAt(x, y + 2) - p00);
  let g11 = vec2f(pressureAt(x + 2, y + 1) - p01, pressureAt(x + 1, y + 2) - p10);
  let gradient = mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y) * 0.5 * view.pressureGain * view.surface;

  let normal = normalize(vec3f(-gradient, 1.0));
  let lightDir = normalize(vec3f(-0.45, -0.6, 0.66));
  let halfway = normalize(lightDir + vec3f(0.0, 0.0, 1.0));
  let specular = pow(max(dot(normal, halfway), 0.0), 60.0);
  let flatSpecular = pow(max(halfway.z, 0.0), 60.0);
  let sheen = max(specular - flatSpecular, 0.0);

  var colour = view.ink + glow(tone(pressure * view.pressureGain)) * view.pressureMix;

  let heat = mix(
    mix(energy[cellIndex(x, y)], energy[cellIndex(x + 1, y)], f.x),
    mix(energy[cellIndex(x, y + 1)], energy[cellIndex(x + 1, y + 1)], f.x),
    f.y,
  );
  let lit = tone(heat * view.energyGain);
  colour += view.energyTint * (lit * lit * 1.3 + lit * lit * lit * lit * 1.6) * view.energyMix;

  colour += view.light * sheen * 0.4 * view.pressureMix;
  return vec4f(colour, 1.0);
}
`;

export const POST_WGSL = /* wgsl */ `
struct Post {
  texel: vec2f,
  threshold: f32,
  intensity: f32,
  time: f32,
  grain: f32,
  vignette: f32,
  exposure: f32,
};

@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var<uniform> post: Post;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn fullscreen(@builtin(vertex_index) index: u32) -> Varyings {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Varyings;
  out.position = vec4f(corners[index], 0.0, 1.0);
  out.uv = vec2f((corners[index].x + 1.0) * 0.5, (1.0 - corners[index].y) * 0.5);
  return out;
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(source, linearSampler, uv, 0.0).rgb;
}

// Four bilinear taps around the centre: a cheap, smooth half-size downsample.
fn box(uv: vec2f) -> vec3f {
  let d = post.texel;
  return (tap(uv + vec2f(-d.x, -d.y)) + tap(uv + vec2f(d.x, -d.y))
    + tap(uv + vec2f(-d.x, d.y)) + tap(uv + vec2f(d.x, d.y))) * 0.25;
}

// Only light above the threshold blooms, with a soft knee so nothing pops in.
@fragment
fn prefilter(in: Varyings) -> @location(0) vec4f {
  let colour = box(in.uv);
  let brightest = max(colour.r, max(colour.g, colour.b));
  let knee = post.threshold * 0.6;
  var soft = clamp(brightest - post.threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  let keep = max(soft, brightest - post.threshold) / max(brightest, 1e-4);
  return vec4f(colour * keep, 1.0);
}

@fragment
fn down(in: Varyings) -> @location(0) vec4f {
  return vec4f(box(in.uv), 1.0);
}

// A 3x3 tent from the smaller level, added onto the larger one by the blend state.
@fragment
fn up(in: Varyings) -> @location(0) vec4f {
  let d = post.texel;
  var sum = tap(in.uv) * 4.0;
  sum += (tap(in.uv + vec2f(-d.x, 0.0)) + tap(in.uv + vec2f(d.x, 0.0))
    + tap(in.uv + vec2f(0.0, -d.y)) + tap(in.uv + vec2f(0.0, d.y))) * 2.0;
  sum += tap(in.uv + vec2f(-d.x, -d.y)) + tap(in.uv + vec2f(d.x, -d.y))
    + tap(in.uv + vec2f(-d.x, d.y)) + tap(in.uv + vec2f(d.x, d.y));
  return vec4f(sum / 16.0, 1.0);
}

// Narkowicz's fit of the ACES film curve: bright light rolls off instead of clipping.
fn filmic(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn composite(in: Varyings) -> @location(0) vec4f {
  let scene = tap(in.uv);
  let bloom = textureSampleLevel(bloomTexture, linearSampler, in.uv, 0.0).rgb;
  var colour = filmic((scene + bloom * post.intensity) * post.exposure);
  let away = length((in.uv - vec2f(0.5)) * vec2f(1.15, 1.0));
  colour *= 1.0 - post.vignette * smoothstep(0.35, 0.95, away);
  colour = pow(colour, vec3f(1.0 / 2.2));
  let noise = hash(in.position.xy + vec2f(post.time * 61.0, post.time * 37.0)) - 0.5;
  return vec4f(colour + noise * post.grain, 1.0);
}
`;
