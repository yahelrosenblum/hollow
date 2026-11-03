// Never lose a room. Every edit is journaled shortly after it happens, and each session marks
// itself open until it closes cleanly, so the next launch can tell a crash from a normal exit.
// A journal entry that fails validation is skipped, and the one before it is used instead.
//
// The closing moments use localStorage, not IndexedDB. A page that's going away can have its
// IndexedDB transactions aborted, but localStorage writes finish before the call returns.

import { validateRoom } from './schema.js';

export const SAVE_DELAY_MS = 400;
const KEEP_VERSIONS = 60;
const SESSION_KEY = 'hollow.session';
const PENDING_KEY = 'hollow.pending';

const memory = new Map();

// Falls back to memory where localStorage is blocked: rooms still work, just not across reloads.
const defaultMarker = {
  get(key) {
    try {
      if (globalThis.localStorage) return globalThis.localStorage.getItem(key);
    } catch {
      // Blocked: use the fallback below.
    }
    return memory.get(key) ?? null;
  },
  set(key, value) {
    try {
      if (globalThis.localStorage) {
        globalThis.localStorage.setItem(key, value);
        return;
      }
    } catch {
      // Blocked or full: use the fallback below.
    }
    memory.set(key, value);
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // Nothing to clean up if it's blocked.
    }
    memory.delete(key);
  },
};

export class Autosave {
  constructor(storage, { delay = SAVE_DELAY_MS, onError = null, marker = defaultMarker } = {}) {
    this.storage = storage;
    this.delay = delay;
    this.onError = onError;
    this.marker = marker;
    this.timer = null;
    this.pending = null;
    this.lastSaved = null;
    this.saving = Promise.resolve();
    this.flushOnHide = () => {
      if (document.visibilityState === 'hidden') this.flush();
    };
  }

  // Finds what, if anything, should be restored. Call before any new edit is journaled.
  async recover() {
    const crashed = this.marker.get(SESSION_KEY) === 'open';
    let skipped = 0;
    const waiting = this.marker.get(PENDING_KEY);
    if (waiting) {
      this.marker.remove(PENDING_KEY);
      try {
        const result = validateRoom(JSON.parse(waiting));
        if (result.ok) return { room: result.room, crashed, skipped, savedAt: Date.now() };
      } catch {
        // Treated the same as a damaged journal entry, below.
      }
      skipped += 1;
    }
    const entries = await this.storage.newest('journal', KEEP_VERSIONS);
    for (const entry of entries) {
      const result = validateRoom(entry.room);
      if (result.ok) {
        return { room: result.room, crashed, skipped, savedAt: entry.savedAt };
      }
      skipped += 1;
    }
    return { room: null, crashed, skipped, savedAt: null };
  }

  begin() {
    this.reopen();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.flushOnHide);
  }

  // Called as the page goes away. An edit still waiting for its save goes to localStorage, so
  // closing the tab straight after a change doesn't lose it.
  endCleanly() {
    if (this.pending && this.pending !== this.lastSaved) {
      try {
        this.marker.set(PENDING_KEY, JSON.stringify(this.pending));
      } catch {
        // Too big or blocked. The journal still has everything up to the last save.
      }
    }
    this.marker.set(SESSION_KEY, 'closed');
    return this.flush();
  }

  // A page restored from the back/forward cache is running again, so it's open again.
  reopen() {
    this.marker.set(SESSION_KEY, 'open');
    this.marker.remove(PENDING_KEY);
  }

  note(room) {
    this.pending = room;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delay);
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const room = this.pending;
    this.pending = null;
    if (!room || room === this.lastSaved) return this.saving;
    this.lastSaved = room;
    this.saving = this.saving
      .then(() => this.storage.put('journal', { room, savedAt: Date.now() }))
      .then(() => this.trim())
      .catch((error) => this.onError?.(error));
    return this.saving;
  }

  async trim() {
    const old = await this.storage.oldestKeysBeyond('journal', KEEP_VERSIONS);
    for (const key of old) await this.storage.delete('journal', key);
  }

  // Recent versions, newest first, for the "earlier versions" list.
  versions(limit = KEEP_VERSIONS) {
    return this.storage.newest('journal', limit);
  }
}
