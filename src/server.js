import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Backend } from './backend.js';
import { isLoopback, loadConfig, validateConfig } from './config.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BROWSER_FRAME = 256 * 1024;
const MAX_BROWSER_BUFFER = 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, fields) => plain(value) && Object.keys(value).every((key) => fields.includes(key));

export function validAudio(audio) {
  if (!hasOnly(audio, ['data', 'sampleRate', 'numChannels', 'samplesPerChannel'])) return false;
  if (![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(audio.sampleRate) || ![1, 2].includes(audio.numChannels)) return false;
  if (!Number.isInteger(audio.samplesPerChannel) || audio.samplesPerChannel < 1 || audio.samplesPerChannel > audio.sampleRate / 2) return false;
  if (typeof audio.data !== 'string' || audio.data.length > 128000 || audio.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) return false;
  const bytes = Buffer.from(audio.data, 'base64');
  return bytes.length === audio.samplesPerChannel * audio.numChannels * 2 && bytes.toString('base64') === audio.data;
}

/** Local-only browser gateway; configuration is never modifiable through HTTP. */
export function createGateway({ config: input, publicDir = PUBLIC, backendFactory = (config) => new Backend(config), startupTimeoutMs = 30_000, stopTimeoutMs = 10_000, heartbeatMs = 20_000 } = {}) {
  const config = validateConfig(input);
  const backends = new Map();
  const contacts = new Map(config.contacts.map((contact) => [contact.id, contact]));
  const leases = new Map();
  const sockets = new Set();
  let shuttingDown = false;
  let heartbeat;
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > MAX_BROWSER_FRAME || socket.bufferedAmount > MAX_BROWSER_BUFFER) { hangup(socket.call); socket.close(1013, 'Connection is congested'); return; }
    socket.send(data);
  };
  const status = (call, state) => send(call.socket, { type: 'status', status: state });
  const error = (socket, message) => send(socket, { type: 'error', message });

  function finish(call, { uncertain = false } = {}) {
    if (call.finished) return;
    call.finished = true;
    clearTimeout(call.startTimer);
    if (uncertain) {
      call.quarantined = true;
      error(call.socket, 'Call cleanup could not be confirmed. This contact is locked to prevent overlapping calls. Check the app-server before restarting the dialer.');
    } else if (leases.get(call.key) === call) leases.delete(call.key);
    if (call.socket.call === call) call.socket.call = null;
    status(call, 'ended');
  }
  async function stop(call) {
    if (call.startRejected) return true;
    if (!call.startSent || !call.backend.alive) return !call.startSent;
    try { await call.backend.request('thread/realtime/stop', { threadId: call.contact.threadId }, { timeoutMs: stopTimeoutMs }); return true; }
    catch { return false; }
  }
  async function cleanUp(call) {
    if (call.cleanup) return call.cleanup;
    call.cleanup = (async () => {
      // Stop promptly only after our start is accepted/observed. A pending start
      // could still reject because another client already owns realtime on this thread.
      const earlyStop = call.started || call.startAccepted ? stop(call) : Promise.resolve(true);
      await call.startWork;
      await earlyStop;
      if (!call.startSent) { finish(call); return; }
      const confirmed = call.startRejected || ((call.started || call.startAccepted) && await stop(call));
      // A timed-out start may still complete later. Never hand its thread to a new call.
      finish(call, { uncertain: call.startUncertain || !confirmed });
    })();
    return call.cleanup;
  }
  function hangup(call) {
    if (!call || call.finished) return;
    if (!call.cancelled) { call.cancelled = true; clearTimeout(call.startTimer); status(call, 'ending'); }
    void cleanUp(call);
  }
  async function recoverLateStart(call, settlement) {
    if (settlement) {
      call.startUncertain = false;
      call.startAccepted = settlement.ok;
      call.startRejected = !settlement.ok;
    }
    if (call.recovering) return;
    call.recovering = true;
    try {
      await call.cleanup;
      const confirmed = call.startRejected || ((call.started || call.startAccepted) && await stop(call));
      if (confirmed && !call.startUncertain && call.quarantined && leases.get(call.key) === call) {
        leases.delete(call.key); call.quarantined = false;
      }
    } finally { call.recovering = false; }
  }
  function handleNotification(backendName, method, params) {
    if (!plain(params) || typeof params.threadId !== 'string') return;
    const call = leases.get(`${backendName}\0${params.threadId}`);
    if (!call || !call.startSent) return;
    if (params.incarnationId && call.incarnationId && params.incarnationId !== call.incarnationId) return;
    if (params.realtimeSessionId && params.realtimeSessionId !== call.sessionId) return;
    if (call.finished || call.cancelled) {
      if (method === 'thread/realtime/started' && params.realtimeSessionId === call.sessionId) {
        call.started = true; call.incarnationId = params.incarnationId ?? null;
        if (call.quarantined) void recoverLateStart(call);
      }
      return;
    }
    let safe;
    if (method === 'thread/realtime/started') {
      call.started = true; call.incarnationId = params.incarnationId ?? null;
      clearTimeout(call.startTimer);
      safe = { realtimeSessionId: params.realtimeSessionId ?? null, incarnationId: call.incarnationId, version: params.version };
      status(call, 'connected');
    } else if (method === 'thread/realtime/sdp') {
      if (call.contact.transport !== 'webrtc' || typeof params.sdp !== 'string' || params.sdp.length > 100000) return;
      safe = { sdp: params.sdp };
    } else if (method === 'thread/realtime/error') {
      safe = { message: 'The realtime app-server reported an error. Check its local logs for details.' };
    } else if (method === 'thread/realtime/closed') {
      safe = { reason: 'The realtime session closed.' };
    } else if (method === 'thread/realtime/transcript/delta' || method === 'thread/realtime/transcript/done') {
      if (!call.started || !['user', 'assistant'].includes(params.role)) return;
      const field = method.endsWith('/delta') ? 'delta' : 'text';
      if (typeof params[field] !== 'string' || params[field].length > 48000) return;
      safe = { role: params.role, [field]: params[field] };
    } else if (method === 'thread/realtime/outputAudio/delta') {
      if (!call.started || call.contact.transport !== 'pcm' || !plain(params.audio)) return;
      const audio = params.audio;
      if (typeof audio.data !== 'string' || audio.data.length > 192000 || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 48000 || ![1, 2].includes(audio.numChannels)) return;
      safe = { audio: { data: audio.data, sampleRate: audio.sampleRate, numChannels: audio.numChannels, samplesPerChannel: audio.samplesPerChannel, itemId: typeof audio.itemId === 'string' ? audio.itemId.slice(0, 256) : null } };
    } else if (method === 'thread/realtime/itemAdded') {
      if (!call.started || params.item?.type !== 'input_audio_buffer.speech_started') return;
      safe = { item: { type: 'input_audio_buffer.speech_started', item_id: typeof params.item.item_id === 'string' ? params.item.item_id.slice(0, 256) : null } };
    } else if (['bridge/permission/requested', 'bridge/question/requested', 'bridge/work/blocked'].includes(method)) {
      error(call.socket, 'The backing agent needs a permission or answer. Open an approval-capable client; this dialer will not approve it.');
      return;
    } else return;
    send(call.socket, { type: 'notification', method, params: safe });
    if (method === 'thread/realtime/error' || method === 'thread/realtime/closed') hangup(call);
  }
  function backendFor(name) {
    if (backends.has(name)) return backends.get(name);
    const backend = backendFactory(config.servers[name]);
    backends.set(name, backend);
    backend.on('notification', (method, params) => handleNotification(name, method, params));
    backend.on('unsupportedRequest', ({ threadId }) => {
      for (const call of leases.values()) {
        if (call.contact.server === name && (!threadId || threadId === call.contact.threadId) && !call.finished) error(call.socket, 'The app-server requested an approval or action this voice-only dialer cannot handle. It was not approved. Use an approval-capable client.');
      }
    });
    backend.on('disconnect', () => {
      for (const call of leases.values()) {
        if (call.contact.server !== name || call.finished) continue;
        error(call.socket, 'The app-server disconnected. The call has ended.');
        call.cancelled = true;
        finish(call, { uncertain: call.startSent });
      }
    });
    return backend;
  }
  function dial(socket, message) {
    if (!hasOnly(message, ['type', 'contactId', 'sdp']) || typeof message.contactId !== 'string') { error(socket, 'Invalid call request'); return; }
    if (socket.call) { error(socket, 'Finish the current call before dialing again'); return; }
    const contact = contacts.get(message.contactId);
    if (!contact) { error(socket, 'Unknown contact'); return; }
    if (contact.transport === 'webrtc' && (typeof message.sdp !== 'string' || message.sdp.length < 10 || message.sdp.length > 100000 || !message.sdp.startsWith('v=0'))) { error(socket, 'A real browser WebRTC SDP offer is required'); return; }
    if (contact.transport === 'pcm' && message.sdp !== undefined) { error(socket, 'This contact uses PCM audio'); return; }
    const key = `${contact.server}\0${contact.threadId}`;
    if (leases.has(key)) { error(socket, 'This thread already has an active or unresolved call'); return; }
    const backend = backendFor(contact.server);
    const call = { key, socket, backend, contact, sessionId: randomUUID(), startSent: false, started: false, cancelled: false, finished: false, startUncertain: false, audioPending: 0 };
    socket.call = call; leases.set(key, call); status(call, 'connecting');
    call.startTimer = setTimeout(() => { error(socket, 'Call startup timed out'); hangup(call); }, startupTimeoutMs);
    call.startWork = (async () => {
      try {
        await backend.connect();
        if (call.cancelled || call.finished) return;
        await backend.request('thread/resume', { threadId: contact.threadId, excludeTurns: true });
        if (call.cancelled || call.finished) return;
        call.startSent = true;
        await backend.request('thread/realtime/start', { threadId: contact.threadId, outputModality: 'audio', realtimeSessionId: call.sessionId, ...contact.realtime, ...(contact.transport === 'webrtc' ? { transport: { type: 'webrtc', sdp: message.sdp } } : {}) }, { onLateSettlement: (settlement) => { if (call.cancelled || call.finished) void recoverLateStart(call, settlement); } });
        call.startAccepted = true;
      } catch (cause) {
        if (call.startSent && cause.code !== 'rpc') call.startUncertain = true;
        if (call.startSent && cause.code === 'rpc') call.startRejected = true;
        if (!call.cancelled && !call.finished) error(socket, call.startSent ? 'Could not start realtime audio. Check app-server compatibility and voice authentication.' : 'Could not connect to or resume the configured thread. Check the local configuration and app-server.');
        call.cancelled = true;
      }
    })().then(() => { if (call.cancelled && !call.finished) void cleanUp(call); });
  }
  function receive(socket, data, binary) {
    if (binary) { socket.close(1003, 'JSON messages required'); return; }
    const now = Date.now();
    if (now - socket.windowStart > 1000) { socket.windowStart = now; socket.frameCount = 0; }
    if (++socket.frameCount > 120) { socket.close(1008, 'Message rate exceeded'); return; }
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (!plain(message)) { error(socket, 'Invalid message'); return; }
    if (message.type === 'call') { dial(socket, message); return; }
    if (message.type === 'hangup' && hasOnly(message, ['type'])) { if (socket.call) hangup(socket.call); else send(socket, { type: 'status', status: 'ended' }); return; }
    if (message.type === 'audio' && hasOnly(message, ['type', 'audio'])) {
      const call = socket.call;
      if (!call || !call.started || call.cancelled || call.finished || call.contact.transport !== 'pcm') { error(socket, 'No active PCM call'); return; }
      if (!validAudio(message.audio)) { error(socket, 'Invalid PCM audio chunk'); hangup(call); return; }
      if (call.audioPending >= 12) { error(socket, 'Audio connection is congested'); hangup(call); return; }
      call.audioPending++;
      void call.backend.request('thread/realtime/appendAudio', { threadId: call.contact.threadId, audio: message.audio }).catch(() => { if (!call.cancelled && !call.finished) { error(socket, 'Could not send microphone audio'); hangup(call); } }).finally(() => call.audioPending--);
      return;
    }
    error(socket, 'Unsupported message');
  }

  function allowedRequest(request, requireOrigin = false) {
    const port = server.address()?.port ?? config.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!hosts.has(request.headers.host)) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    if (!origin) return !requireOrigin;
    return origin === `http://${request.headers.host}`;
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    response.setHeader('Cache-Control', 'no-store');
    if (!allowedRequest(request)) { response.writeHead(403).end('Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed'); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end('Bad request'); return; }
    if (pathname === '/api/contacts') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? '' : JSON.stringify({ contacts: config.contacts.map(({ id, name, transport }) => ({ id, name, transport })) })); return;
    }
    try {
      const root = await realpath(publicDir);
      const file = await realpath(path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`));
      if (!file.startsWith(`${root}${path.sep}`) || !(await stat(file)).isFile() || !MIME[path.extname(file)]) { response.writeHead(404).end('Not found'); return; }
      response.setHeader('Content-Type', MIME[path.extname(file)]);
      response.end(request.method === 'HEAD' ? '' : await readFile(file));
    } catch { response.writeHead(404).end('Not found'); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_FRAME, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (shuttingDown || request.url !== '/call' || !allowedRequest(request, true) || sockets.size >= 32) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket) => {
    sockets.add(socket); socket.isAlive = true; socket.frameCount = 0; socket.windowStart = Date.now();
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, binary) => receive(socket, data, binary));
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); hangup(socket.call); });
  });
  return {
    server, backends, leases,
    async listen({ port = config.port, host = config.host } = {}) {
      if (!isLoopback(host)) throw new Error('The dialer can bind only to loopback');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      heartbeat = setInterval(() => { for (const socket of sockets) { if (!socket.isAlive) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } }, heartbeatMs); heartbeat.unref();
      return server.address();
    },
    async close() {
      shuttingDown = true; clearInterval(heartbeat);
      for (const call of leases.values()) hangup(call);
      const cleanups = [...leases.values()].map((call) => call.cleanup).filter(Boolean);
      await Promise.race([Promise.allSettled(cleanups), new Promise((resolve) => { const timer = setTimeout(resolve, stopTimeoutMs + 100); timer.unref(); })]);
      for (const socket of sockets) socket.terminate();
      for (const backend of backends.values()) backend.close();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  let filename = process.env.VOICE_DIALER_CONFIG ?? 'config.json';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: node src/server.js [--config path/to/config.json]');
    filename = args[1];
  }
  const config = await loadConfig(filename);
  const gateway = createGateway({ config });
  const address = await gateway.listen();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  process.stdout.write(`Thread Voice Dialer: http://${host}:${address.port}\n`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (!closing) { closing = true; void gateway.close(); } });
  return gateway;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
