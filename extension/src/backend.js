// Runs `neurons.mjs dashboard` with the system Node and talks to it in JSON lines; the editor's own Node never opens the database
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESTARTS = 5;

export class Backend extends EventEmitter {
  constructor({ node, script, env, log }) {
    super();
    Object.assign(this, { node, script, env, log });
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.disposed = false;
    this.start();
  }

  start() {
    const child = spawn(this.node, [this.script, 'dashboard'], { env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    // Writing to a backend that just died must not take the editor's extension host down with it
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.log(`backend: ${line}`));
    child.on('error', (err) => {
      this.log(`backend failed to start: ${err.message}`);
      // A spawn that never started (bad Node path) gets no exit event
      if (!child.pid) this.emit('dead');
    });
    child.on('exit', (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('The Neurons backend stopped.'));
      }
      this.pending.clear();
      if (this.disposed) return;
      this.log(`backend exited (${signal || code})`);
      // A crash is retried a few times with growing pauses; a backend that keeps dying is reported, not looped forever
      if (this.restarts < MAX_RESTARTS) {
        const wait = 500 * 2 ** this.restarts++;
        setTimeout(() => !this.disposed && this.start(), wait);
      } else {
        this.emit('dead');
      }
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.log(`backend: ${line}`);
    }
    if (msg.event) return this.emit('event', msg.event);
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    this.restarts = 0;
    msg.ok ? waiter.resolve(msg.data) : waiter.reject(new Error(msg.error));
  }

  request(cmd, args = {}) {
    if (this.disposed) return Promise.reject(new Error('Neurons is shutting down.'));
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error('The Neurons backend is restarting; try again in a moment.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Neurons backend did not answer "${cmd}" in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  dispose() {
    this.disposed = true;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {}
  }
}
