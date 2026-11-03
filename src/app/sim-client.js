// The interface's handle on the simulation thread: requests that resolve, and events.

export class SimClient {
  constructor() {
    this.worker = new Worker(new URL('../sim/worker.js', import.meta.url), { type: 'module' });
    this.waiting = new Map();
    this.nextId = 1;
    this.listeners = new Map();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => this.emit('worker-error', { message: event.message });
  }

  receive(message) {
    if (message.type === 'reply') {
      const entry = this.waiting.get(message.id);
      if (!entry) return;
      this.waiting.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      return;
    }
    this.emit(message.type, message);
  }

  on(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...list, listener]);
    return () => {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
    };
  }

  emit(type, message) {
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }

  request(type, payload = {}, transfer = []) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  // For things like claps, where nothing waits on the answer and speed matters.
  send(type, payload = {}, transfer = []) {
    this.worker.postMessage({ type, payload }, transfer);
  }

  destroy() {
    this.worker.terminate();
  }
}
