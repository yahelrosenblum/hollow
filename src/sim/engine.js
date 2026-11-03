// The GPU solver. It owns the field buffers and runs batches of steps; it knows nothing
// about the interface, audio devices or rendering.

import { fastCoefficients } from './numerics.js';
import {
  ENERGY_WGSL, MAX_INJECTORS, MAX_TAPS, PROBE_ENTRY_FLOATS, PROBE_WGSL, STEP_UNIFORM_BYTES, WAVE_WGSL, WORKGROUP_X,
} from './wave.wgsl.js';

export const MAX_BATCH_STEPS = 2048;
const STAGING_RING = 6;
const PROBE_VALUES_OFFSET = 16; // tap values follow the cursor in the probe output buffer
const FRAME_MEMORY_BYTES = 96 * 1024 * 1024;
const MAX_FRAMES = 240;
const CHECKPOINT_SLOTS = 16;
const TIMING_RING = 4;

// The two rotations of the three fields, as [cur, prev, next]. Each step moves to the next
// ordering in its list. Reversing time switches list, because it swaps cur and prev.
const FORWARD_ORDER = [[0, 1, 2], [2, 0, 1], [1, 2, 0]];
const REVERSED_ORDER = [[1, 0, 2], [2, 1, 0], [0, 2, 1]];

function storageEntry(binding, type) {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } };
}

export class WaveEngine {
  // Use WaveEngine.create: a failed pipeline must stop here, not quietly compute nothing.
  static async create(device, options = {}) {
    device.pushErrorScope('validation');
    const engine = new WaveEngine(device, options);
    const error = await device.popErrorScope();
    if (error) throw new Error(`Solver failed to compile: ${error.message}`);
    return engine;
  }

  constructor(device, { headless = false } = {}) {
    this.device = device;
    this.headless = headless;
    this.timing = !headless && device.features.has('timestamp-query') ? this.createTiming() : null;
    this.lastGpuMs = null;
    this.steps = 0;
    this.reversed = false;
    this.position = 0;
    this.reedGain = 0;
    this.reedLevel = 1;
    this.grid = null;
    this.energyDecay = 1;

    // Each later layout extends the one before, so switching pipeline needs no rebinding.
    this.staticLayout = device.createBindGroupLayout({
      label: 'wave static',
      entries: [
        storageEntry(0, 'uniform'),
        storageEntry(1, 'read-only-storage'),
        storageEntry(2, 'read-only-storage'),
      ],
    });
    this.fieldLayout = device.createBindGroupLayout({
      label: 'wave fields',
      entries: [
        storageEntry(0, 'read-only-storage'),
        storageEntry(1, 'read-only-storage'),
        storageEntry(2, 'storage'),
      ],
    });
    this.probeLayout = device.createBindGroupLayout({
      label: 'wave probe',
      entries: [
        storageEntry(0, 'uniform'),
        storageEntry(1, 'read-only-storage'),
        storageEntry(2, 'storage'),
      ],
    });
    this.energyLayout = device.createBindGroupLayout({
      label: 'wave energy',
      entries: [storageEntry(0, 'uniform'), storageEntry(1, 'storage')],
    });
    this.stepPipeline = device.createComputePipeline({
      label: 'wave step',
      layout: device.createPipelineLayout({
        label: 'wave step',
        bindGroupLayouts: [this.staticLayout, this.fieldLayout],
      }),
      compute: { module: device.createShaderModule({ label: 'wave', code: WAVE_WGSL }), entryPoint: 'waveStep' },
    });
    this.probePipeline = device.createComputePipeline({
      label: 'wave probe',
      layout: device.createPipelineLayout({
        label: 'wave probe',
        bindGroupLayouts: [this.staticLayout, this.fieldLayout, this.probeLayout],
      }),
      compute: { module: device.createShaderModule({ label: 'probe', code: PROBE_WGSL }), entryPoint: 'probe' },
    });
    this.energyPipeline = device.createComputePipeline({
      label: 'wave energy',
      layout: device.createPipelineLayout({
        label: 'wave energy',
        bindGroupLayouts: [this.staticLayout, this.fieldLayout, this.probeLayout, this.energyLayout],
      }),
      compute: { module: device.createShaderModule({ label: 'energy', code: ENERGY_WGSL }), entryPoint: 'energyStep' },
    });
  }

  get order() {
    return (this.reversed ? REVERSED_ORDER : FORWARD_ORDER)[this.position];
  }

  // Real GPU time for a batch, from timestamp queries. WebGPU has no way to ask how busy the
  // GPU is overall, so this is what the performance history reports, and it says so.
  createTiming() {
    const { device } = this;
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    return {
      querySet,
      resolve: device.createBuffer({
        label: 'timing resolve',
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      }),
      ring: Array.from({ length: TIMING_RING }, () => ({
        busy: false,
        buffer: device.createBuffer({
          label: 'timing read',
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      })),
    };
  }

  readTiming(slot) {
    slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const [start, end] = new BigUint64Array(slot.buffer.getMappedRange());
      if (end > start) this.lastGpuMs = Number(end - start) / 1e6;
      slot.buffer.unmap();
      slot.busy = false;
    }).catch(() => {
      slot.busy = false;
    });
  }

  // Copies the two newest fields aside, so this exact moment can be returned to later.
  restoreCheckpoint(slot) {
    const { device, frameBytes } = this;
    const [cur, prev] = this.order;
    const encoder = device.createCommandEncoder({ label: 'restore checkpoint' });
    const base = slot * frameBytes * 2;
    encoder.copyBufferToBuffer(this.checkpointBuffer, base, this.fields[cur], 0, frameBytes);
    encoder.copyBufferToBuffer(this.checkpointBuffer, base + frameBytes, this.fields[prev], 0, frameBytes);
    device.queue.submit([encoder.finish()]);
  }

  // Copies one stored frame over another, such as the display slot.
  copyFrame(from, to) {
    const { device, frameBytes } = this;
    const encoder = device.createCommandEncoder({ label: 'copy frame' });
    encoder.copyBufferToBuffer(this.frames, from * frameBytes, this.frames, to * frameBytes, frameBytes);
    device.queue.submit([encoder.finish()]);
  }

  readFrame(frame) {
    return this.readRange(this.frames, frame * this.frameBytes, this.frameBytes);
  }

  async readRange(buffer, offset, size) {
    const { device } = this;
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, offset, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange()).slice();
    staging.destroy();
    return values;
  }

  // Replaces the grid. Field contents are kept only when the size is unchanged.
  loadGrid(compiled) {
    const { device } = this;
    const sameSize = this.grid && this.grid.nx === compiled.nx && this.grid.ny === compiled.ny;
    this.grid = compiled;
    if (!sameSize) this.allocate(compiled);
    device.queue.writeBuffer(this.flagsBuffer, 0, compiled.flags);
    device.queue.writeBuffer(this.coefBuffer, 0, compiled.coef);
    this.writeStepParams();
  }

  // Uploads just the cells inside a changed rectangle, one row at a time.
  updateRegion(compiled, rect) {
    const { queue } = this.device;
    const { nx } = compiled;
    const width = rect.x1 - rect.x0 + 1;
    for (let y = rect.y0; y <= rect.y1; y += 1) {
      const first = y * nx + rect.x0;
      queue.writeBuffer(this.flagsBuffer, first * 4, compiled.flags, first, width);
      queue.writeBuffer(this.coefBuffer, first * 16, compiled.coef, first * 4, width * 4);
    }
    this.grid = compiled;
  }

  allocate({ nx, ny }) {
    const { device } = this;
    this.destroyBuffers();
    const bytes = nx * ny * 4;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const pointBytes = PROBE_ENTRY_FLOATS * 4;
    const make = (label, size, usage) => device.createBuffer({ label, size, usage });

    this.fields = [0, 1, 2].map((n) => make(
      `field ${n}`,
      bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    ));
    this.flagsBuffer = make('flags', bytes, storage);
    this.coefBuffer = make('coef', bytes * 4, storage);
    this.stepUniform = make('step params', STEP_UNIFORM_BYTES, uniform);
    this.probeUniform = make('probe params', 16, uniform);
    this.tapPointsOffset = MAX_INJECTORS * pointBytes;
    this.samplesOffset = (MAX_INJECTORS + MAX_TAPS) * pointBytes;
    this.probeData = make(
      'probe data',
      this.samplesOffset + MAX_BATCH_STEPS * MAX_INJECTORS * 4,
      storage,
    );
    this.probeOut = make(
      'probe output',
      PROBE_VALUES_OFFSET + MAX_BATCH_STEPS * MAX_TAPS * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    this.energyUniform = make('energy params', 16, uniform);
    this.energy = make(
      'energy',
      bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    // A baking engine has no display, so it needs no frame history or checkpoints.
    this.frameCount = this.headless
      ? 2
      : Math.max(2, Math.min(MAX_FRAMES, Math.floor(FRAME_MEMORY_BYTES / bytes)));
    this.frameBytes = bytes;
    this.frames = make(
      'field frames',
      this.frameCount * bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    this.slots = this.headless ? 0 : CHECKPOINT_SLOTS;
    this.checkpointBuffer = this.slots
      ? make('checkpoints', this.slots * bytes * 2, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST)
      : null;
    this.staging = Array.from({ length: STAGING_RING }, (_, n) => ({
      busy: false,
      buffer: make(
        `tap staging ${n}`,
        MAX_BATCH_STEPS * MAX_TAPS * 4,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      ),
    }));

    this.staticGroup = device.createBindGroup({
      label: 'wave static',
      layout: this.staticLayout,
      entries: [this.stepUniform, this.flagsBuffer, this.coefBuffer]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.probeGroup = device.createBindGroup({
      label: 'wave probe',
      layout: this.probeLayout,
      entries: [this.probeUniform, this.probeData, this.probeOut]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.energyGroup = device.createBindGroup({
      label: 'wave energy',
      layout: this.energyLayout,
      entries: [this.energyUniform, this.energy]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const groupFor = ([cur, prev, next]) => device.createBindGroup({
      label: `fields ${cur}${prev}${next}`,
      layout: this.fieldLayout,
      entries: [cur, prev, next].map((n, binding) => ({ binding, resource: { buffer: this.fields[n] } })),
    });
    this.forwardGroups = FORWARD_ORDER.map(groupFor);
    this.reversedGroups = REVERSED_ORDER.map(groupFor);
    this.reversed = false;
    this.position = 0;
    this.steps = 0;
    this.writeEnergyParams();
  }

  writeStepParams() {
    const { nx, ny, lambda2, g0 } = this.grid;
    const { axial, diagonal } = fastCoefficients(lambda2);
    const data = new ArrayBuffer(STEP_UNIFORM_BYTES);
    new Uint32Array(data, 0, 2).set([nx, ny]);
    new Float32Array(data, 8, 6).set([lambda2, 1 / (1 + g0), axial, diagonal, this.reedGain, this.reedLevel]);
    this.device.queue.writeBuffer(this.stepUniform, 0, data);
    this.writeEnergyParams();
  }

  writeEnergyParams() {
    if (!this.grid || !this.energyUniform) return;
    const data = new ArrayBuffer(16);
    new Uint32Array(data, 0, 2).set([this.grid.nx, this.grid.ny]);
    new Float32Array(data, 8, 1).set([this.energyDecay]);
    this.device.queue.writeBuffer(this.energyUniform, 0, data);
  }

  setEnergyDecay(decay) {
    this.energyDecay = decay;
    this.writeEnergyParams();
  }

  setReed(gain, level) {
    this.reedGain = gain;
    this.reedLevel = level;
    if (this.grid) this.writeStepParams();
  }

  clear() {
    const encoder = this.device.createCommandEncoder();
    for (const buffer of this.fields) encoder.clearBuffer(buffer);
    encoder.clearBuffer(this.energy);
    this.device.queue.submit([encoder.finish()]);
  }

  // Exchanging the two newest fields reverses time.
  reverse() {
    const [cur, prev] = this.order;
    this.reversed = !this.reversed;
    const list = this.reversed ? REVERSED_ORDER : FORWARD_ORDER;
    this.position = list.findIndex((o) => o[0] === prev && o[1] === cur);
  }

  freeStaging() {
    return this.staging.find((s) => !s.busy) ?? null;
  }

  // Runs `count` steps. `injectors`/`taps` are arrays of {x, y, dx, dy}; `samples` holds
  // count * injectors.length source values. Resolves with count * taps.length tap values.
  // Resolves to null, having done nothing, if every staging buffer is still in flight.
  // `captures` copies the field after a given step (1-based) into a frame slot.
  runBatch(count, {
    injectors = [], taps = [], samples = null, energyEvery = 0, captures = [], checkpoint = null,
  } = {}) {
    if (count > MAX_BATCH_STEPS) throw new RangeError(`batch of ${count} exceeds ${MAX_BATCH_STEPS}`);
    if (injectors.length > MAX_INJECTORS || taps.length > MAX_TAPS) throw new RangeError('too many probe points');
    const slot = this.freeStaging();
    if (!slot) return Promise.resolve(null);

    const { device, grid } = this;
    const { queue } = device;
    const usesProbe = injectors.length > 0 || taps.length > 0;
    if (usesProbe) {
      queue.writeBuffer(this.probeUniform, 0, new Uint32Array([grid.nx, injectors.length, taps.length, injectors.length]));
      queue.writeBuffer(this.probeOut, 0, new Uint32Array([0]));
      if (injectors.length) {
        queue.writeBuffer(this.probeData, 0, packPoints(injectors));
        queue.writeBuffer(this.probeData, this.samplesOffset, samples);
      }
      if (taps.length) queue.writeBuffer(this.probeData, this.tapPointsOffset, packPoints(taps));
    }

    const encoder = device.createCommandEncoder({ label: 'wave batch' });
    const groupsX = Math.ceil(grid.nx / WORKGROUP_X);
    const { ny } = grid;
    const order = this.reversed ? REVERSED_ORDER : FORWARD_ORDER;
    const groups = this.reversed ? this.reversedGroups : this.forwardGroups;
    const { stepPipeline, probePipeline, energyPipeline } = this;
    let at = this.position;
    let capture = 0;

    const timingSlot = this.timing?.ring.find((s) => !s.busy) ?? null;
    if (timingSlot) {
      encoder.beginComputePass({
        label: 'timing start',
        timestampWrites: { querySet: this.timing.querySet, beginningOfPassWriteIndex: 0 },
      }).end();
    }

    const openPass = () => {
      const pass = encoder.beginComputePass({ label: 'wave steps' });
      pass.setBindGroup(0, this.staticGroup);
      pass.setBindGroup(2, this.probeGroup);
      pass.setBindGroup(3, this.energyGroup);
      return pass;
    };
    let pass = openPass();
    for (let n = 0; n < count; n += 1) {
      pass.setPipeline(stepPipeline);
      pass.setBindGroup(1, groups[at]);
      pass.dispatchWorkgroups(groupsX, ny);
      if (usesProbe) {
        pass.setPipeline(probePipeline);
        pass.dispatchWorkgroups(1);
      }
      if (energyEvery && (this.steps + n + 1) % energyEvery === 0) {
        pass.setPipeline(energyPipeline);
        pass.dispatchWorkgroups(groupsX, ny);
      }
      while (capture < captures.length && captures[capture].step === n + 1) {
        pass.end();
        encoder.copyBufferToBuffer(
          this.fields[order[at][2]],
          0,
          this.frames,
          captures[capture].frame * this.frameBytes,
          this.frameBytes,
        );
        pass = openPass();
        capture += 1;
      }
      at = (at + 1) % 3;
    }
    pass.end();
    this.position = at;
    this.steps += count;

    if (checkpoint !== null && this.checkpointBuffer) {
      const [cur, prev] = this.order;
      const base = checkpoint * this.frameBytes * 2;
      encoder.copyBufferToBuffer(this.fields[cur], 0, this.checkpointBuffer, base, this.frameBytes);
      encoder.copyBufferToBuffer(this.fields[prev], 0, this.checkpointBuffer, base + this.frameBytes, this.frameBytes);
    }
    if (timingSlot) {
      encoder.beginComputePass({
        label: 'timing end',
        timestampWrites: { querySet: this.timing.querySet, endOfPassWriteIndex: 1 },
      }).end();
      encoder.resolveQuerySet(this.timing.querySet, 0, 2, this.timing.resolve, 0);
      encoder.copyBufferToBuffer(this.timing.resolve, 0, timingSlot.buffer, 0, 16);
      timingSlot.busy = true;
    }

    const tapValues = count * taps.length;
    if (tapValues === 0) {
      queue.submit([encoder.finish()]);
      if (timingSlot) this.readTiming(timingSlot);
      return queue.onSubmittedWorkDone().then(() => new Float32Array(0));
    }
    encoder.copyBufferToBuffer(this.probeOut, PROBE_VALUES_OFFSET, slot.buffer, 0, tapValues * 4);
    queue.submit([encoder.finish()]);
    if (timingSlot) this.readTiming(timingSlot);
    slot.busy = true;
    return slot.buffer.mapAsync(GPUMapMode.READ, 0, tapValues * 4).then(() => {
      const values = new Float32Array(slot.buffer.getMappedRange(0, tapValues * 4)).slice();
      slot.buffer.unmap();
      slot.busy = false;
      return values;
    });
  }

  // Copies a whole field to the CPU. For measurement and tests, never in the audio path.
  async readField(which = 'cur') {
    return this.readBuffer(this.fieldBuffer(which));
  }

  readEnergy() {
    return this.readBuffer(this.energy);
  }

  async readBuffer(buffer) {
    const { device } = this;
    const staging = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(staging.getMappedRange()).slice();
    staging.destroy();
    return values;
  }

  fieldBuffer(which) {
    const [cur, prev, next] = this.order;
    return this.fields[{ cur, prev, next }[which]];
  }

  writeField(which, values) {
    this.device.queue.writeBuffer(this.fieldBuffer(which), 0, values);
  }

  destroyBuffers() {
    if (!this.fields) return;
    const owned = [
      ...this.fields, this.flagsBuffer, this.coefBuffer, this.stepUniform, this.probeUniform,
      this.probeData, this.probeOut, this.energyUniform, this.energy, this.frames,
      ...this.staging.map((s) => s.buffer),
      ...(this.checkpointBuffer ? [this.checkpointBuffer] : []),
    ];
    for (const buffer of owned) buffer.destroy();
    this.fields = null;
  }
}

function packPoints(points) {
  const data = new Float32Array(points.length * PROBE_ENTRY_FLOATS);
  points.forEach((p, n) => {
    data.set([p.x, p.y, p.dx ?? 0, p.dy ?? 0], n * PROBE_ENTRY_FLOATS);
  });
  return data;
}
