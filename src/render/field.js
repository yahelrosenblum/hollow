// Draws solver data to the canvas. Runs in the worker, so drawing never waits on the UI.
// The scene is drawn as light into a high-range texture, then bloomed, tone mapped and
// finished like a photograph. The solver's data is only read, never altered.

import { POST_WGSL, SCENE_WGSL } from './field.wgsl.js';
import { DEFAULT_PALETTE, PALETTES } from './palettes.js';

const VIEW_BYTES = 144;
const POST_BYTES = 32;
const HDR = 'rgba16float';
const BLOOM_LEVELS = 5;
const BLOOM = {
  threshold: 0.55,
  intensity: 0.9,
  exposure: 1.15,
  vignette: 0.42,
  grain: 0.022,
};

// Palettes are written as screen colours. Light adds up in linear space, so they're converted.
function linear(rgb) {
  return rgb.map((c) => c ** 2.2);
}

export class FieldRenderer {
  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    const scene = device.createShaderModule({ label: 'field scene', code: SCENE_WGSL });
    const post = device.createShaderModule({ label: 'field post', code: POST_WGSL });
    this.scenePipeline = device.createRenderPipeline({
      label: 'field scene',
      layout: 'auto',
      vertex: { module: scene, entryPoint: 'vertexMain' },
      fragment: { module: scene, entryPoint: 'fragmentMain', targets: [{ format: HDR }] },
    });
    const postPipeline = (entryPoint, format, blend) => device.createRenderPipeline({
      label: `field ${entryPoint}`,
      layout: 'auto',
      vertex: { module: post, entryPoint: 'fullscreen' },
      fragment: { module: post, entryPoint, targets: [{ format, blend }] },
    });
    const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    this.prefilterPipeline = postPipeline('prefilter', HDR);
    this.downPipeline = postPipeline('down', HDR);
    this.upPipeline = postPipeline('up', HDR, add);
    this.compositePipeline = postPipeline('composite', this.format);
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.uniform = device.createBuffer({
      label: 'field view',
      size: VIEW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sceneGroup = null;
    this.targets = null;
    this.engine = null;
    this.view = { pixelsPerCell: 1, originX: 0, originY: 0 };
    this.palette = PALETTES[DEFAULT_PALETTE];
    this.surface = 1;
    this.still = false;
    this.started = performance.now();
    this.errorCount = 0;
  }

  bind(engine) {
    this.engine = engine;
    this.sceneGroup = this.device.createBindGroup({
      label: 'field scene',
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: engine.frames } },
        { binding: 2, resource: { buffer: engine.energy } },
        { binding: 3, resource: { buffer: engine.flagsBuffer } },
      ],
    });
  }

  setPalette(key) {
    this.palette = PALETTES[key] ?? PALETTES[DEFAULT_PALETTE];
  }

  // With reduced motion the liquid sheen and the moving grain both stop.
  setSurface(strength) {
    this.surface = strength;
    this.still = strength === 0;
  }

  resize(width, height) {
    if (width > 0 && height > 0 && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.destroyTargets();
    }
  }

  setView(view) {
    this.view = view;
  }

  destroyTargets() {
    if (!this.targets) return;
    this.targets.scene.destroy();
    for (const level of this.targets.levels) level.texture.destroy();
    for (const buffer of this.targets.buffers) buffer.destroy();
    this.targets = null;
  }

  // The scene at full size, then a chain of halvings for the bloom, each with its own small
  // uniform holding the size of the texture it reads from.
  buildTargets() {
    const { device, canvas } = this;
    const texture = (label, width, height) => device.createTexture({
      label,
      size: [Math.max(1, width), Math.max(1, height)],
      format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const scene = texture('field scene', canvas.width, canvas.height);
    const levels = [];
    let width = canvas.width;
    let height = canvas.height;
    for (let i = 0; i < BLOOM_LEVELS; i += 1) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
      const t = texture(`bloom ${i}`, width, height);
      levels.push({ texture: t, view: t.createView(), width, height });
    }
    const buffers = [];
    const uniform = (sourceWidth, sourceHeight) => {
      const buffer = device.createBuffer({ size: POST_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new Float32Array(POST_BYTES / 4);
      data.set([1 / sourceWidth, 1 / sourceHeight, BLOOM.threshold, BLOOM.intensity, 0, BLOOM.grain, BLOOM.vignette, BLOOM.exposure]);
      device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffer;
    };
    const group = (pipeline, sourceView, buffer, extra = null) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: { buffer } },
        ...(extra ? [{ binding: 3, resource: extra }] : []),
      ],
    });
    const sceneView = scene.createView();
    const passes = [{
      pipeline: this.prefilterPipeline, target: levels[0].view, load: 'clear',
      group: group(this.prefilterPipeline, sceneView, uniform(canvas.width, canvas.height)),
    }];
    for (let i = 1; i < BLOOM_LEVELS; i += 1) {
      const from = levels[i - 1];
      passes.push({
        pipeline: this.downPipeline, target: levels[i].view, load: 'clear',
        group: group(this.downPipeline, from.view, uniform(from.width, from.height)),
      });
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i -= 1) {
      const from = levels[i];
      passes.push({
        pipeline: this.upPipeline, target: levels[i - 1].view, load: 'load',
        group: group(this.upPipeline, from.view, uniform(from.width, from.height)),
      });
    }
    const compositeUniform = uniform(canvas.width, canvas.height);
    this.targets = {
      scene,
      sceneView,
      levels,
      buffers,
      passes,
      compositeUniform,
      compositeGroup: group(this.compositePipeline, sceneView, compositeUniform, levels[0].view),
    };
  }

  draw({ frame, pressureGain, energyGain, energyMix, pressureMix, wipeX = -1, wipeFrame = 0 }) {
    if (!this.sceneGroup || !this.engine?.fields) return;
    if (!this.targets) this.buildTargets();
    const { device, palette, view, engine, canvas, targets } = this;
    const data = new ArrayBuffer(VIEW_BYTES);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set([canvas.width, canvas.height, view.originX, view.originY, view.pixelsPerCell], 0);
    u[5] = frame * (engine.frameBytes / 4);
    u[6] = engine.grid.nx;
    u[7] = engine.grid.ny;
    f.set([pressureGain, energyGain, energyMix, pressureMix], 8);
    f.set(linear(palette.ink), 12);
    f[15] = wipeX;
    f.set(linear(palette.positive), 16);
    u[19] = wipeFrame * (engine.frameBytes / 4);
    f.set(linear(palette.negative), 20);
    f.set(linear(palette.energy), 24);
    f.set(linear(palette.wall), 28);
    f.set(linear(palette.light), 32);
    f[35] = this.surface;
    device.queue.writeBuffer(this.uniform, 0, data);
    const seconds = this.still ? 0 : (performance.now() - this.started) / 1000;
    device.queue.writeBuffer(targets.compositeUniform, 16, new Float32Array([seconds % 1000]));

    const encoder = device.createCommandEncoder({ label: 'field draw' });
    const run = (pipeline, target, group, load = 'clear') => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };
    run(this.scenePipeline, targets.sceneView, this.sceneGroup);
    for (const pass of targets.passes) run(pass.pipeline, pass.target, pass.group, pass.load);
    run(this.compositePipeline, this.context.getCurrentTexture().createView(), targets.compositeGroup);
    device.queue.submit([encoder.finish()]);
  }
}
