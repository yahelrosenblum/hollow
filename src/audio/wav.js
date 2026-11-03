// WAV encoding and decoding. No audio processing happens here: what goes in comes back out.

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

// channels: array of Float32Array, all the same length. bits: 24 or 32 (float).
// `note` goes in an INFO comment, so a file carries what it is with it.
export function encodeWav(channels, rate, { bits = 32, note = '' } = {}) {
  if (bits !== 24 && bits !== 32) throw new RangeError('bits must be 24 or 32');
  const frames = channels[0].length;
  const count = channels.length;
  const bytesPerSample = bits / 8;
  const dataBytes = frames * count * bytesPerSample;
  const commentBytes = note ? new TextEncoder().encode(note) : new Uint8Array(0);
  const padded = commentBytes.length + 1 + ((commentBytes.length + 1) % 2);
  const listBytes = note ? 4 + 8 + padded : 0;
  const total = 44 + dataBytes + (dataBytes % 2) + (note ? 8 + listBytes : 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bits === 32 ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * count * bytesPerSample, true);
  view.setUint16(32, count * bytesPerSample, true);
  view.setUint16(34, bits, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < count; c += 1) {
      const v = channels[c][n];
      if (bits === 32) {
        view.setFloat32(at, v, true);
      } else {
        const clamped = Math.max(-1, Math.min(1, v));
        const int = Math.round(clamped < 0 ? clamped * 8388608 : clamped * 8388607);
        view.setUint8(at, int & 255);
        view.setUint8(at + 1, (int >> 8) & 255);
        view.setUint8(at + 2, (int >> 16) & 255);
      }
      at += bytesPerSample;
    }
  }
  if (dataBytes % 2) at += 1;
  if (note) {
    writeString(view, at, 'LIST');
    view.setUint32(at + 4, listBytes, true);
    writeString(view, at + 8, 'INFO');
    writeString(view, at + 12, 'ICMT');
    view.setUint32(at + 16, padded, true);
    new Uint8Array(buffer, at + 20, commentBytes.length).set(commentBytes);
  }
  return buffer;
}

export function decodeWav(buffer) {
  const view = new DataView(buffer);
  const tag = (offset) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let format = null;
  let channels = null;
  let rate = null;
  let bits = null;
  let data = null;
  let note = '';
  while (at + 8 <= buffer.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = { offset: body, size };
    } else if (id === 'LIST' && tag(body) === 'INFO' && tag(body + 4) === 'ICMT') {
      const length = view.getUint32(body + 8, true);
      const bytes = new Uint8Array(buffer, body + 12, length);
      const end = bytes.indexOf(0);
      note = new TextDecoder().decode(bytes.subarray(0, end < 0 ? length : end));
    }
    at = body + size + (size % 2);
  }
  if (!data || !channels) throw new Error('WAV file is missing its format or data');
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.size / (channels * bytesPerSample));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let read = data.offset;
  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < channels; c += 1) {
      if (format === FORMAT_FLOAT && bits === 32) {
        out[c][n] = view.getFloat32(read, true);
      } else if (format === FORMAT_PCM && bits === 24) {
        let int = view.getUint8(read) | (view.getUint8(read + 1) << 8) | (view.getUint8(read + 2) << 16);
        if (int & 0x800000) int -= 0x1000000;
        out[c][n] = int < 0 ? int / 8388608 : int / 8388607;
      } else {
        throw new Error(`unsupported WAV format ${format}/${bits}`);
      }
      read += bytesPerSample;
    }
  }
  return { channels: out, rate, bits, note };
}
