import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { childEnvironment } from './config.js';

export class BackendError extends Error {
  constructor(message, code = 'backend') { super(message); this.code = code; }
}
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_BUFFER = 1024 * 1024;

/** A shared, long-lived JSON-RPC connection, never closed merely for hangup. */
export class Backend extends EventEmitter {
  constructor(config, { timeoutMs = 20_000, connectTimeoutMs = 10_000, env = process.env } = {}) {
    super();
    this.config = config; this.timeoutMs = timeoutMs; this.connectTimeoutMs = connectTimeoutMs; this.env = env;
    this.pending = new Map(); this.lateSettlements = new Map(); this.nextId = 1; this.generation = 0; this.ready = false; this.closed = false;
  }
  connect() {
    if (this.closed) return Promise.reject(new BackendError('App-server connection is closed'));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().then(async () => {
      await this.request('initialize', { clientInfo: { name: 'thread_voice_dialer', title: 'Thread Voice Dialer', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.notify('initialized', {});
      this.ready = true;
    }).catch((error) => {
      this.terminateTransport();
      throw error instanceof BackendError ? error : new BackendError('Cannot connect to the configured app-server');
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  open() {
    const generation = ++this.generation;
    this.alive = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        finish(new BackendError('App-server connection timed out', 'timeout'));
        this.terminateTransport();
      }, this.connectTimeoutMs);
      const onDisconnect = () => {
        if (generation !== this.generation) return;
        finish(new BackendError('App-server disconnected'));
        this.terminateTransport();
      };
      const message = (data) => {
        if (generation === this.generation) this.receive(data);
      };
      try {
        if (this.config.url) {
          const ws = this.ws = new WebSocket(this.config.url, { maxPayload: MAX_FRAME, perMessageDeflate: false, followRedirects: false, handshakeTimeout: this.connectTimeoutMs });
          ws.on('open', () => finish());
          ws.on('message', (data, isBinary) => { if (isBinary) this.terminateTransport(); else message(data); });
          ws.on('close', onDisconnect);
          ws.on('error', onDisconnect);
        } else {
          const child = this.child = spawn(this.config.command, this.config.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: childEnvironment(this.config.env, this.env) });
          let buffer = Buffer.alloc(0);
          child.on('spawn', () => finish());
          child.on('error', onDisconnect); child.on('exit', onDisconnect);
          child.stdin.on('error', onDisconnect);
          child.stdout.on('data', (chunk) => {
            if (generation !== this.generation) return;
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
              const index = buffer.indexOf(10);
              if (index === -1) break;
              if (index > MAX_FRAME) { this.terminateTransport(); return; }
              const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
              if (line.length) message(line);
              if (!this.alive) return;
            }
            if (buffer.length > MAX_FRAME) this.terminateTransport();
          });
          // Drain without exposing backend diagnostics, tokens, paths, or URLs to the browser.
          child.stderr.on('data', () => {});
        }
      } catch { finish(new BackendError('Cannot launch the configured app-server')); this.disconnected(); }
    });
  }
  request(method, params, { timeoutMs = this.timeoutMs, onLateSettlement } = {}) {
    if (!this.alive) return Promise.reject(new BackendError('App-server disconnected'));
    if (this.pending.size >= 128 || (onLateSettlement && this.lateSettlements.size >= 256)) return Promise.reject(new BackendError('App-server request capacity reached', 'capacity'));
    const id = `dialer-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (onLateSettlement) this.lateSettlements.set(id, onLateSettlement);
        reject(new BackendError('App-server request timed out', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  notify(method, params) { this.send({ method, params }); }
  send(value) {
    const text = JSON.stringify(value);
    if (!this.alive || Buffer.byteLength(text) > MAX_FRAME) throw new BackendError('App-server connection unavailable');
    if (this.ws) {
      if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > MAX_BUFFER) throw new BackendError('App-server connection is congested');
      this.ws.send(text);
    } else {
      if (!this.child?.stdin.writable || this.child.stdin.writableLength > MAX_BUFFER) throw new BackendError('App-server connection is congested');
      this.child.stdin.write(`${text}\n`);
    }
  }
  receive(data) {
    let value;
    try {
      if (data.length > MAX_FRAME) throw new Error();
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch { this.terminateTransport(); return; }
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        // Fail closed for approvals, tools, elicitation, credentials, and all unsupported callbacks.
        try { this.send({ id: value.id, error: { code: -32601, message: 'This voice-only client does not support server requests. Use an approval-capable client.' } }); } catch {}
        this.emit('unsupportedRequest', { threadId: value.params?.threadId });
      } else this.emit('notification', value.method, value.params);
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      const late = this.lateSettlements.get(value.id);
      if (late) { this.lateSettlements.delete(value.id); late({ ok: !value.error && Object.hasOwn(value, 'result') }); }
      return;
    }
    this.pending.delete(value.id); clearTimeout(pending.timer);
    if (value.error) pending.reject(new BackendError('The app-server rejected the request', 'rpc'));
    else if (!Object.hasOwn(value, 'result')) pending.reject(new BackendError('Invalid app-server response'));
    else pending.resolve(value.result);
  }
  disconnected() {
    if (!this.alive) return;
    this.alive = false; this.ready = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BackendError('App-server disconnected')); }
    this.pending.clear(); this.lateSettlements.clear();
    this.emit('disconnect');
  }
  terminateTransport() {
    const ws = this.ws; const child = this.child;
    this.ws = null; this.child = null;
    this.disconnected();
    ws?.terminate();
    if (child) {
      child.stdin.destroy(); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
  close() { this.closed = true; this.terminateTransport(); }
}
