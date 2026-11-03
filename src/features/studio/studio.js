// Recording Studio. Nothing here adds reverb: a take is what the simulated ears received, and
// an exported impulse response is a measured room.

import { button, el, select, slider } from '../../app/dom.js';
import { newId } from '../../scene/room.js';
import { downloadBlob, safeFilename } from '../../ui/files.js';
import { EXPORT_NOTE, impulseResponseWav, recordingWav, resample } from '../../audio/ir.js';
import { throughChain } from '../lab/measure.js';
import { sourcePointFor } from '../lab/lab.js';
import { MATERIALS } from '../../sim/materials.js';
import { Recorder, matchedGains } from './recorder.js';
import { RATES } from '../../sim/governor.js';
import { StreamResampler } from '../../audio/resampler.js';

const IR_MAX_SECONDS = 6;
const IR_QUIET_DB = -70;

function formatLength(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : `${seconds.toFixed(1)} s`;
}

function relative(timestamp) {
  return new Date(timestamp).toLocaleString();
}

export function studioWorkspace(app) {
  const state = {
    recorder: null,
    takeNumber: 1,
    bits: 32,
    file: null,
    fileVoice: null,
    mic: null,
    micWanted: false,
    micStarting: false,
    micHeadphones: false,
    playing: null,
    irBusy: false,
    removeSamples: null,
  };
  let recordButton;
  let recordNote;
  let historyList;
  let presetList;
  let irStatus;

  function recorder() {
    if (!state.recorder) state.recorder = new Recorder(app.storage);
    return state.recorder;
  }

  function ensureListening() {
    if (state.removeSamples) return;
    // Recording keeps going while you switch workspace, so this listener stays installed.
    state.removeSamples = app.addSampleListener((message) => {
      if (recorder().recording && recorder().push(message)) stopRecording('The simulation rate changed, which ended the take.');
    });
  }

  async function toggleRecording() {
    if (recorder().recording) {
      await stopRecording();
      return;
    }
    app.ensureAudio();
    await recorder().start(app.room, app.rate, `${app.room.name}, take ${state.takeNumber}`);
    state.takeNumber += 1;
    ensureListening();
    refreshRecording();
    app.announce('Recording');
  }

  async function stopRecording(reason) {
    const meta = await recorder().stop();
    refreshRecording();
    await renderHistory();
    if (reason) app.toast(reason);
    else if (meta) app.toast(`Saved ${meta.name}.`);
    app.announce('Recording stopped');
  }

  function refreshRecording() {
    if (!recordButton) return;
    const on = recorder().recording;
    recordButton.textContent = on ? 'Stop recording' : 'Record';
    recordButton.setAttribute('aria-pressed', String(on));
    recordNote.textContent = on
      ? 'Recording what your ears receive. Clap, draw, move around: all of it is in the take.'
      : 'Records your two ears and what the sources emitted, straight from the solver. It keeps recording if you switch workspace.';
  }

  function stopPlayback() {
    state.playing?.stop();
    state.playing = null;
  }

  function play(channels, rate, gain = app.volume) {
    stopPlayback();
    const { context } = app.output;
    app.ensureAudio();
    const buffer = context.createBuffer(channels.length, channels[0].length, rate);
    channels.forEach((channel, n) => buffer.copyToChannel(channel, n));
    const source = context.createBufferSource();
    source.buffer = buffer;
    const node = context.createGain();
    node.gain.value = gain;
    source.connect(node).connect(context.destination);
    source.start();
    state.playing = source;
  }

  async function playTake(meta, which) {
    const take = await recorder().load(meta);
    const wetL = throughChain(take.left.subarray(0, take.frames), meta.rate);
    const wetR = throughChain(take.right.subarray(0, take.frames), meta.rate);
    const dry = take.input.subarray(0, take.frames);
    const gains = matchedGains(wetL, dry);
    if (which === 'wet') {
      play([wetL.map((v) => v * gains.a), wetR.map((v) => v * gains.a)], meta.rate, app.volume);
    } else {
      play([dry.map((v) => v * gains.b)], meta.rate, app.volume);
    }
  }

  async function exportTake(meta) {
    const take = await recorder().load(meta);
    const wav = recordingWav(take.left.subarray(0, take.frames), take.right.subarray(0, take.frames), meta.rate, { bits: state.bits });
    downloadBlob(new Blob([wav], { type: 'audio/wav' }), `${safeFilename(meta.name)}.wav`);
  }

  async function restoreRoom(meta) {
    await app.loadRoom(meta.room, { keepHistory: true });
    app.renderPanel();
    app.toast(`Restored the room from "${meta.name}". Undo goes back.`);
  }

  async function renderHistory() {
    if (!historyList) return;
    const takes = await recorder().list().catch(() => []);
    if (!takes.length) {
      historyList.replaceChildren(el('li', { class: 'note', text: 'No takes yet.' }));
      return;
    }
    historyList.replaceChildren(...takes.map((meta) => el(
      'li',
      {},
      el(
        'div',
        { class: 'list-row' },
        el('span', { class: 'name', text: meta.name }),
        el('span', { class: 'note', style: 'margin:0', text: formatLength(meta.frames / meta.rate) }),
      ),
      el('p', { class: 'note', style: 'margin:2px 0', text: `${relative(meta.createdAt)}${meta.open ? ' · cut off by a crash, everything saved is here' : ''}` }),
      el(
        'div',
        { class: 'btn-grid' },
        button('Play room', () => playTake(meta, 'wet').catch((e) => app.toast(e.message))),
        button('Play dry', () => playTake(meta, 'dry').catch((e) => app.toast(e.message))),
        button('Export', () => exportTake(meta).catch((e) => app.toast(e.message))),
        button('Its room', () => restoreRoom(meta)),
        button('Delete', async () => {
          await recorder().remove(meta);
          renderHistory();
        }),
      ),
    )));
  }

  // The response is bake-measured until it has really died away, so the file has no cut-off
  // tail, up to a limit. Baked at the highest rate regardless of what live audio can manage.
  async function exportImpulseResponse(rate) {
    if (state.irBusy) return;
    state.irBusy = true;
    const off = app.sim.on('bake-progress', ({ progress }) => {
      irStatus.textContent = `Measuring at ${(rate / 1000).toFixed(1)} kHz… ${Math.round(progress * 100)}%`;
    });
    try {
      const room = app.room;
      const result = await app.sim.request('bake', {
        room,
        sources: [{ point: sourcePointFor(room), stimulus: { kind: 'impulse' } }],
        listeners: 'ears',
        seconds: IR_MAX_SECONDS,
        rate,
      });
      const trimmed = trimTail(result.traces[0], result.traces[1], result.rate);
      const wav = impulseResponseWav(trimmed.left, trimmed.right, result.rate, { bits: state.bits });
      downloadBlob(new Blob([wav], { type: 'audio/wav' }), `${safeFilename(room.name)} impulse response.wav`);
      state.lastIr = { wav, rate: result.rate, seconds: trimmed.seconds };
      irStatus.textContent = `Exported ${trimmed.seconds.toFixed(2)} s, stereo, 48 kHz, ${state.bits}-bit. ${EXPORT_NOTE}`;
    } catch (error) {
      irStatus.textContent = `The export failed: ${error.message}`;
    } finally {
      off();
      state.irBusy = false;
    }
  }

  function trimTail(traceL, traceR, rate) {
    const left = throughChain(traceL, rate);
    const right = throughChain(traceR, rate);
    let peak = 0;
    for (let n = 0; n < left.length; n += 1) peak = Math.max(peak, Math.abs(left[n]), Math.abs(right[n]));
    const floor = peak * 10 ** (IR_QUIET_DB / 20);
    let last = left.length - 1;
    while (last > 0 && Math.abs(left[last]) < floor && Math.abs(right[last]) < floor) last -= 1;
    const end = Math.min(traceL.length, last + Math.round(rate * 0.05));
    return { left: traceL.subarray(0, end), right: traceR.subarray(0, end), seconds: end / rate };
  }

  // --- sound files and the microphone, played into the room ---

  async function loadFile(file) {
    try {
      const data = await file.arrayBuffer();
      const decoded = await app.output.context.decodeAudioData(data);
      const mono = new Float32Array(decoded.length);
      for (let c = 0; c < decoded.numberOfChannels; c += 1) {
        const channel = decoded.getChannelData(c);
        for (let n = 0; n < mono.length; n += 1) mono[n] += channel[n] / decoded.numberOfChannels;
      }
      state.file = { name: file.name, signal: resample(mono, decoded.sampleRate, app.rate), rate: app.rate };
      await startFile();
    } catch {
      app.toast('That file could not be read as audio.');
    }
  }

  async function startFile() {
    if (!state.file) return;
    await stopFile();
    app.ensureAudio();
    const signal = state.file.rate === app.rate ? state.file.signal : resample(state.file.signal, state.file.rate, app.rate);
    const reply = await app.sim.request('addBuffer', {
      point: sourcePointFor(app.room), signal: signal.map((v) => v * 0.7), loop: true,
    });
    state.fileVoice = reply.id;
    app.toast(`Playing ${state.file.name} inside the room.`);
    app.renderPanel();
  }

  async function stopFile() {
    if (state.fileVoice !== null) app.sim.send('stopVoice', { id: state.fileVoice });
    state.fileVoice = null;
  }

  // Hold-to-talk: wanting the mic and having it are separate, because getting it takes time and
  // can show a permission prompt that swallows the release. If the button has been let go by
  // the time the mic arrives, it's shut straight back off. A live mic must never be left on.
  async function micOn() {
    state.micWanted = true;
    if (state.mic || state.micStarting) return;
    state.micStarting = true;
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (!state.micWanted) throw new DOMException('released', 'AbortError');
      await connectMic(stream);
      if (!state.micWanted) micOff();
    } catch (error) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (error.name !== 'AbortError') app.toast('The microphone is unavailable, or permission was refused.');
    } finally {
      state.micStarting = false;
    }
  }

  async function connectMic(stream) {
    const { context } = app.output;
    await context.audioWorklet.addModule(new URL('../../audio/mic-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(context, 'hollow-mic', { numberOfOutputs: 0 });
    const input = context.createMediaStreamSource(stream);
    input.connect(node);
    const reply = await app.sim.request('startStream', { point: sourcePointFor(app.room) });
    const resampler = new StreamResampler(context.sampleRate, app.rate);
    node.port.onmessage = ({ data }) => {
      const block = resampler.process(data);
      app.sim.send('stream', { id: reply.id, block }, [block.buffer]);
    };
    state.mic = {
      id: reply.id, stream, node, input,
    };
    app.ensureAudio();
    app.announce('Microphone on');
  }

  function micOff() {
    state.micWanted = false;
    const { mic } = state;
    if (!mic) return;
    mic.node.port.onmessage = null;
    mic.input.disconnect();
    mic.node.disconnect();
    for (const track of mic.stream.getTracks()) track.stop();
    app.sim.send('stopVoice', { id: mic.id });
    state.mic = null;
    app.announce('Microphone off');
  }

  // --- presets ---

  async function savePreset(kind) {
    const list = await app.storage.all('presets').catch(() => []);
    const same = list.filter((p) => p.kind === kind).length + 1;
    const { room } = app;
    const preset = kind === 'sources'
      ? {
        id: newId('p'), kind, name: `Speakers ${same}: ${room.speakers?.length ?? 0} in ${room.name}`, speakers: room.speakers ?? [],
      }
      : {
        id: newId('p'),
        kind,
        name: `Acoustics ${same}: from ${room.name}`,
        airLoss: room.airLoss,
        edges: room.edges,
        edgeMaterial: room.edgeMaterial,
      };
    await app.storage.put('presets', preset);
    renderPresets();
  }

  function applyPreset(preset) {
    if (preset.kind === 'sources') {
      app.commit({ ...app.room, speakers: preset.speakers.map((s) => ({ ...s })) });
    } else {
      const { airLoss, edges, edgeMaterial } = preset;
      app.commit({
        ...app.room, airLoss, edges, edgeMaterial, lossless: false,
      });
      app.refreshSizeSoon();
    }
    app.toast(`Applied "${preset.name}".`);
  }

  async function renderPresets() {
    if (!presetList) return;
    const presets = await app.storage.all('presets').catch(() => []);
    if (!presets.length) {
      presetList.replaceChildren(el('li', { class: 'note', text: 'None saved yet.' }));
      return;
    }
    presetList.replaceChildren(...presets.map((preset) => el(
      'li',
      {},
      el(
        'div',
        { class: 'list-row' },
        el('span', { class: 'name', text: preset.name }),
        button('Apply', () => applyPreset(preset)),
        button('Delete', async () => {
          await app.storage.delete('presets', preset.id);
          renderPresets();
        }),
      ),
    )));
  }

  function renderMic() {
    if (!state.micHeadphones) {
      return button('I am wearing headphones', () => {
        state.micHeadphones = true;
        app.renderPanel();
      });
    }
    const hold = button('Hold to talk', null, { class: 'btn wide primary' });
    hold.addEventListener('pointerdown', () => {
      micOn();
      // On the window, because this button may be gone or covered by the time it's let go.
      window.addEventListener('pointerup', micOff, { once: true });
      window.addEventListener('pointercancel', micOff, { once: true });
      window.addEventListener('blur', micOff, { once: true });
    });
    hold.addEventListener('pointerleave', micOff);
    hold.addEventListener('blur', micOff);
    hold.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) micOn();
    });
    hold.addEventListener('keyup', micOff);
    return hold;
  }

  function render() {
    recordButton = button('Record', toggleRecording, { class: 'btn wide primary', 'aria-pressed': 'false' });
    recordNote = el('p', { class: 'note' });
    historyList = el('ul', { class: 'list' });
    presetList = el('ul', { class: 'list' });
    irStatus = el('p', { class: 'note', text: 'A stereo response you can load into any convolution reverb. It carries no added reverb, only this simulated room.' });
    refreshRecording();
    renderHistory();
    renderPresets();
    const bits = select({
      label: 'File format',
      value: String(state.bits),
      options: [{ value: '32', label: '32-bit float' }, { value: '24', label: '24-bit' }],
      onchange: (value) => { state.bits = Number(value); },
    });
    const irRate = select({
      label: 'Measure at',
      value: String(RATES[0]),
      options: RATES.map((r) => ({ value: String(r), label: `${r / 1000} kHz (sound up to ${(r * 0.25 / 1000).toFixed(1)} kHz)` })),
      onchange: () => {},
    });
    const fileInput = el('input', {
      type: 'file',
      accept: 'audio/*',
      style: 'display:none',
      onchange: (event) => {
        const [file] = event.target.files;
        if (file) loadFile(file);
      },
    });
    const air = slider({
      label: 'Air loss',
      min: 0,
      max: 20,
      step: 0.1,
      value: app.room.airLoss,
      format: (v) => v.toFixed(1),
      oninput: (v) => {
        app.commit({ ...app.room, airLoss: v, lossless: false }, { group: 'air' });
      },
    });
    const edge = select({
      label: 'Room edge',
      value: app.room.edges === 'open' ? 'open' : (app.room.edgeMaterial ?? 'stone'),
      options: [
        ...MATERIALS.filter((m) => ['stone', 'wood', 'mirror'].includes(m.key)).map((m) => ({ value: m.key, label: m.label })),
        { value: 'open', label: 'Open air' },
      ],
      onchange: (value) => {
        app.commit(value === 'open'
          ? { ...app.room, edges: 'open', lossless: false }
          : { ...app.room, edges: 'closed', edgeMaterial: value, lossless: false });
        app.refreshSizeSoon();
      },
    });
    return [
      el('h2', { text: 'Studio' }),
      el('p', { class: 'placard', text: 'Play a sound inside your room, record what it does, and take the room with you.' }),
      recordButton,
      recordNote,
      el('h3', { text: 'Takes' }),
      historyList,
      el('h3', { text: 'Play a sound into the room' }),
      el(
        'div',
        { class: 'btn-row' },
        button('Choose audio file', () => fileInput.click()),
        state.fileVoice !== null ? button('Stop file', async () => {
          await stopFile();
          app.renderPanel();
        }) : null,
        fileInput,
      ),
      el('p', { class: 'note', text: 'Files stay on this device. They play from the point the room suggests, or from your last clap.' }),
      el('p', { class: 'note', text: 'To sing into the room, wear headphones first: on speakers the microphone would hear itself and howl.' }),
      renderMic(),
      el('h3', { text: 'Impulse response' }),
      irStatus,
      irRate.row,
      bits.row,
      button('Export impulse response', () => exportImpulseResponse(Number(irRate.input.value)), { class: 'btn wide' }),
      el('h3', { text: 'Acoustics of this room' }),
      air.row,
      edge.row,
      el('h3', { text: 'Presets' }),
      el(
        'div',
        { class: 'btn-row' },
        button('Save speakers', () => savePreset('sources')),
        button('Save acoustics', () => savePreset('acoustic')),
      ),
      presetList,
    ].filter(Boolean);
  }

  return {
    key: 'studio',
    label: 'Studio',
    render,
    onShow() {
      app.setTool(app.workspaces.find((w) => w.key === 'listen').tool);
      state.offReset = app.sim.on('voices-reset', () => {
        // The solver has dropped these voices, so nothing here may claim they're playing.
        state.fileVoice = null;
        micOff();
        if (app.active?.key === 'studio') app.renderPanel();
      });
    },
    onHide() {
      state.offReset?.();
      micOff();
    },
    get recorder() {
      return recorder();
    },
    toggleRecording,
    exportImpulseResponse,
    get lastIr() {
      return state.lastIr;
    },
  };
}
