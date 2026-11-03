// A room as a link. It lives in the URL fragment, which browsers never send to a server, so
// sharing a room shares it with the person you send it to and nobody else.

import { validateRoom } from './schema.js';

const PREFIX = '#room=';
const MAX_LINK_CHARS = 60000;

async function collect(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    // Stops a tiny link that decompresses into something enormous.
    if (size > 8 * 1024 * 1024) throw new Error('this link expands to too much data');
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Coordinates to the millimetre: plenty for this grid, and much shorter.
function compactNumbers(key, value) {
  return typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
}

export async function encodeRoom(room) {
  const json = JSON.stringify(room, compactNumbers);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(await collect(stream));
}

export async function roomLink(room, base) {
  const encoded = await encodeRoom(room);
  const link = `${base}${PREFIX}${encoded}`;
  if (link.length > MAX_LINK_CHARS) {
    return { ok: false, error: 'This room is too detailed to fit in a link. Export it as a file instead.' };
  }
  return { ok: true, link };
}

export async function decodeRoom(encoded) {
  try {
    const stream = new Blob([fromBase64Url(encoded)]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = await collect(stream);
    return validateRoom(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    return { ok: false, error: `This link does not contain a readable room (${error.message}).` };
  }
}

export function roomFromHash(hash) {
  return hash.startsWith(PREFIX) ? hash.slice(PREFIX.length) : null;
}
