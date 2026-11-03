// Undo and redo over immutable rooms: a stack of snapshots, nothing cleverer.

const LIMIT = 200;

export class History {
  constructor(initial) {
    this.past = [];
    this.present = initial;
    this.future = [];
  }

  // A `group` merges consecutive edits, so dragging a wall is one undo, not hundreds.
  push(next, group = null) {
    if (next === this.present) return;
    if (!(group && group === this.lastGroup)) {
      this.past = [...this.past.slice(-(LIMIT - 1)), this.present];
    }
    this.lastGroup = group;
    this.present = next;
    this.future = [];
  }

  replace(next) {
    this.present = next;
  }

  reset(initial) {
    this.past = [];
    this.future = [];
    this.present = initial;
    this.lastGroup = null;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    if (!this.canUndo) return this.present;
    this.future = [this.present, ...this.future];
    this.present = this.past[this.past.length - 1];
    this.past = this.past.slice(0, -1);
    this.lastGroup = null;
    return this.present;
  }

  redo() {
    if (!this.canRedo) return this.present;
    this.past = [...this.past, this.present];
    [this.present] = this.future;
    this.future = this.future.slice(1);
    this.lastGroup = null;
    return this.present;
  }
}
