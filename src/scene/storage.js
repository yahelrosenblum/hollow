// IndexedDB behind a small promise interface. Saved rooms, the autosave journal, presets and
// recording chunks all live here, on this device only.

const DB_NAME = 'hollow';
const DB_VERSION = 1;
const STORES = {
  rooms: { keyPath: 'id' },
  journal: { keyPath: 'seq', autoIncrement: true },
  presets: { keyPath: 'id' },
  recordings: { keyPath: 'id' },
  chunks: { keyPath: ['recording', 'index'] },
  meta: { keyPath: 'key' },
};

function promised(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('storage transaction aborted'));
  });
}

export class Storage {
  constructor(factory = globalThis.indexedDB) {
    this.factory = factory;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!this.factory) throw new Error('This browser has no local storage for rooms.');
    const request = this.factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, options] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      }
    };
    this.db = await promised(request);
    return this.db;
  }

  // Once the database is open, the transaction starts in this same tick, with no await first.
  // That's what lets a write made while the page is closing actually land.
  put(store, value) {
    if (!this.db) return this.open().then(() => this.put(store, value));
    const tx = this.db.transaction(store, 'readwrite');
    const key = tx.objectStore(store).put(value);
    return finished(tx).then(() => key.result);
  }

  async get(store, key) {
    const db = await this.open();
    return promised(db.transaction(store).objectStore(store).get(key));
  }

  async all(store) {
    const db = await this.open();
    return promised(db.transaction(store).objectStore(store).getAll());
  }

  async delete(store, key) {
    const db = await this.open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await finished(tx);
  }

  async deleteRange(store, range) {
    const db = await this.open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(range);
    await finished(tx);
  }

  // Newest first, up to `limit`.
  async newest(store, limit) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const out = [];
      const cursor = db.transaction(store).objectStore(store).openCursor(null, 'prev');
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(c.value);
        c.continue();
      };
    });
  }

  async oldestKeysBeyond(store, keep) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const keys = [];
      let seen = 0;
      const cursor = db.transaction(store).objectStore(store).openKeyCursor(null, 'prev');
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve(keys);
          return;
        }
        seen += 1;
        if (seen > keep) keys.push(c.primaryKey);
        c.continue();
      };
    });
  }
}
