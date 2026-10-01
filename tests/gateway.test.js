import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Backend } from '../src/backend.js';
import { createGateway, validAudio } from '../src/server.js';
import { validateConfig, childEnvironment } from '../src/config.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = 'condition', timeout = 1500) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${message}`); await delay(5); }
}
const contact = (overrides = {}) => ({ id: 'agent', name: 'My Agent', server: 'native', threadId: 'existing-thread', transport: 'webrtc', ...overrides });
const reply = (socket, request, result = {}) => socket.send(JSON.stringify({ id: request.id, result }));
const notice = (socket, method, params) => socket.send(JSON.stringify({ method, params }));

async function fixture(t, { handler, contacts = [contact()], backendTimeout = 500, startupTimeout = 800, stopTimeout = 100 } = {}) {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(fake, 'listening');
  const requests = [], replies = [], backendSockets = [];
  fake.on('connection', (socket) => {
    backendSockets.push(socket);
    socket.on('message', async (raw) => {
      const request = JSON.parse(raw);
      if (!request.method) { replies.push(request); return; }
      requests.push(request);
      if (await handler?.(socket, request, { requests, replies })) return;
      if (request.id === undefined) return;
      reply(socket, request, request.method === 'thread/resume' ? { thread: { id: request.params.threadId } } : {});
      if (request.method === 'thread/realtime/start') {
        notice(socket, 'thread/realtime/started', { threadId: request.params.threadId, realtimeSessionId: request.params.realtimeSessionId, incarnationId: 'epoch-1', version: 'v3' });
        if (request.params.transport) notice(socket, 'thread/realtime/sdp', { threadId: request.params.threadId, sdp: 'v=0\r\nreal-answer' });
      }
    });
  });
  const publicDir = await mkdtemp(path.join(os.tmpdir(), 'dialer-public-'));
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Dialer</title>');
  const config = { servers: { native: { url: `ws://127.0.0.1:${fake.address().port}` } }, contacts };
  const gateway = createGateway({ config, publicDir, startupTimeoutMs: startupTimeout, stopTimeoutMs: stopTimeout, backendFactory: (settings) => new Backend(settings, { timeoutMs: backendTimeout, connectTimeoutMs: 500 }) });
  const address = await gateway.listen({ port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const clients = [];
  async function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/call`, { origin });
    const messages = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw)));
    socket.on('error', () => {});
    await once(socket, 'open'); clients.push(socket);
    return { socket, messages, send: (message) => socket.send(JSON.stringify(message)), wait: (predicate) => until(() => messages.find(predicate), 'browser message').then(() => messages.find(predicate)) };
  }
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    await gateway.close();
    for (const socket of fake.clients) socket.terminate();
    await new Promise((resolve) => fake.close(resolve));
    await rm(publicDir, { recursive: true, force: true });
  });
  return { gateway, origin, address, config, client, requests, replies, backendSockets };
}
const start = (client, id = 'agent') => client.send({ type: 'call', contactId: id, sdp: 'v=0\r\nbrowser-generated-offer' });
const isStatus = (state) => (message) => message.type === 'status' && message.status === state;

test('configuration accepts only loopback targets, explicit env references, and configured contacts', () => {
  const base = { servers: { native: { command: 'codex', args: ['app-server'], env: { TOKEN: { fromEnv: 'EXISTING_TOKEN' } } } }, contacts: [contact()] };
  const config = validateConfig(base);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 4310);
  assert.deepEqual(childEnvironment(config.servers.native.env, { PATH: '/bin', EXISTING_TOKEN: 'secret', UNREQUESTED: 'private' }), { PATH: '/bin', TOKEN: 'secret' });
  assert.throws(() => validateConfig({ ...base, host: '0.0.0.0' }), /loopback/);
  for (const url of ['ws://example.com:4000', 'wss://127.0.0.1', 'ws://user:secret@127.0.0.1', 'ws://127.0.0.1?token=secret']) assert.throws(() => validateConfig({ ...base, servers: { native: { url } } }));
  assert.throws(() => validateConfig({ ...base, servers: { native: { command: 'node', env: { TOKEN: 'embedded-secret' } } } }));
  assert.throws(() => validateConfig({ ...base, contacts: [contact({ realtime: { version: 'v2' } })] }), /does not support WebRTC/);
  assert.throws(() => childEnvironment({ TOKEN: { fromEnv: 'MISSING' } }, {}), /missing/);
  const marked = childEnvironment({ CODEX_SANDBOX_NETWORK_DISABLED: { fromEnv: 'OTHER' } }, { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', OTHER: '0', CODEX_HOME: '/custom/codex', CODEX_SQLITE_HOME: '/custom/sqlite' });
  assert.equal(marked.CODEX_SANDBOX, 'seatbelt');
  assert.equal(marked.CODEX_SANDBOX_NETWORK_DISABLED, '1');
  assert.equal(marked.CODEX_HOME, '/custom/codex');
  assert.equal(marked.CODEX_SQLITE_HOME, '/custom/sqlite');
});

test('contacts strip server details and HTTP rejects foreign host/origin', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/contacts`);
  assert.deepEqual(await response.json(), { contacts: [{ id: 'agent', name: 'My Agent', transport: 'webrtc' }] });
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(f.origin)).status, 200);
  assert.equal((await fetch(f.origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(f.origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const status = await new Promise((resolve, reject) => { const req = http.get(f.origin, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(status, 403);
  assert.equal((await fetch(`${f.origin}/api/rpc`, { method: 'POST', body: '{}' })).status, 405);
  await assert.rejects(f.gateway.listen({ host: '0.0.0.0' }), /loopback/);
});

test('WebSocket rejects missing/foreign Origin and non-call route', async (t) => {
  const f = await fixture(t);
  for (const [route, origin] of [['/call', undefined], ['/call', 'http://evil.example'], ['/anything', f.origin]]) {
    const socket = new WebSocket(f.origin.replace('http:', 'ws:') + route, origin ? { origin } : {});
    await assert.rejects(once(socket, 'open'), /403/);
  }
});

test('dials existing thread, initializes once, and retains backend across hangups and contacts', async (t) => {
  const f = await fixture(t, { contacts: [contact(), contact({ id: 'second', threadId: 'second-thread' })] });
  const a = await f.client(); start(a);
  await a.wait(isStatus('connected'));
  const sdp = await a.wait((message) => message.method === 'thread/realtime/sdp');
  assert.deepEqual(sdp.params, { sdp: 'v=0\r\nreal-answer' });
  assert.equal(f.requests[0].method, 'initialize');
  assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
  assert.ok(f.requests.some((request) => request.method === 'initialized'));
  assert.deepEqual(f.requests.find((request) => request.method === 'thread/resume').params, { threadId: 'existing-thread', excludeTurns: true });
  const call = f.requests.find((request) => request.method === 'thread/realtime/start');
  assert.equal(call.params.outputModality, 'audio'); assert.equal(call.params.transport.type, 'webrtc');
  a.send({ type: 'hangup' }); await a.wait(isStatus('ended'));
  assert.equal(f.backendSockets[0].readyState, WebSocket.OPEN);
  const b = await f.client(); start(b, 'second'); await b.wait(isStatus('connected'));
  assert.equal(f.backendSockets.length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'initialize').length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/start').length, 2);
  assert.equal(f.requests.some((request) => request.method === 'thread/start'), false);
});

test('one lease per server thread, including alias contacts', async (t) => {
  const f = await fixture(t, { contacts: [contact(), contact({ id: 'alias' })] });
  const a = await f.client(), b = await f.client(); start(a); await a.wait(isStatus('connected'));
  start(b, 'alias'); await b.wait((message) => message.type === 'error' && /active/.test(message.message));
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/start').length, 1);
  a.send({ type: 'hangup' }); await a.wait(isStatus('ended'));
  start(b, 'alias'); await b.wait(isStatus('connected'));
});

test('hangup during delayed start sends prompt and final stop before releasing lease', async (t) => {
  let deferred;
  const f = await fixture(t, { handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { deferred = { socket, request }; return true; }
  } });
  const a = await f.client(); start(a); await until(() => deferred);
  a.send({ type: 'hangup' }); await a.wait(isStatus('ending'));
  await until(() => f.requests.some((request) => request.method === 'thread/realtime/stop'));
  assert.equal(f.gateway.leases.size, 1);
  notice(deferred.socket, 'thread/realtime/started', { threadId: 'existing-thread', realtimeSessionId: deferred.request.params.realtimeSessionId });
  reply(deferred.socket, deferred.request);
  await a.wait(isStatus('ended'));
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/stop').length, 2);
  assert.equal(a.messages.some(isStatus('connected')), false);
  assert.equal(f.gateway.leases.size, 0);
  assert.equal(f.backendSockets[0].readyState, WebSocket.OPEN);
});

test('hangup during resume never sends realtime start', async (t) => {
  let deferred;
  const f = await fixture(t, { handler: (socket, request) => {
    if (request.method === 'thread/resume') { deferred = { socket, request }; return true; }
  } });
  const a = await f.client(); start(a); await until(() => deferred);
  a.send({ type: 'hangup' }); await a.wait(isStatus('ending'));
  reply(deferred.socket, deferred.request); await a.wait(isStatus('ended'));
  assert.equal(f.requests.some((request) => request.method === 'thread/realtime/start'), false);
  assert.equal(f.gateway.leases.size, 0);
});

test('browser disconnect stops voice but preserves backend connection', async (t) => {
  const f = await fixture(t); const a = await f.client(); start(a); await a.wait(isStatus('connected'));
  a.socket.terminate();
  await until(() => f.gateway.leases.size === 0);
  assert.ok(f.requests.some((request) => request.method === 'thread/realtime/stop'));
  assert.equal(f.backendSockets[0].readyState, WebSocket.OPEN);
});

test('startup timeout remains quarantined when start result is uncertain', async (t) => {
  const f = await fixture(t, { backendTimeout: 60, startupTimeout: 100, handler: (_socket, request) => request.method === 'thread/realtime/start' });
  const a = await f.client(); start(a); await a.wait(isStatus('ended'));
  assert.equal(f.gateway.leases.size, 1);
  const b = await f.client(); start(b); await b.wait((message) => message.type === 'error' && /unresolved/.test(message.message));
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/start').length, 1);
});

test('stop failure quarantines the thread instead of overlapping a later call', async (t) => {
  const f = await fixture(t, { handler: (_socket, request) => request.method === 'thread/realtime/stop' });
  const a = await f.client(); start(a); await a.wait(isStatus('connected')); a.send({ type: 'hangup' }); await a.wait(isStatus('ended'));
  assert.equal(f.gateway.leases.size, 1);
  assert.ok(a.messages.some((message) => message.type === 'error' && /cleanup/.test(message.message)));
});

test('thread and session fencing hides foreign events and old-incarnation close', async (t) => {
  const f = await fixture(t); const a = await f.client(); start(a); await a.wait(isStatus('connected'));
  const socket = f.backendSockets[0];
  notice(socket, 'thread/realtime/transcript/delta', { threadId: 'different-thread', role: 'assistant', delta: 'secret foreign text' });
  notice(socket, 'thread/realtime/closed', { threadId: 'existing-thread', incarnationId: 'old-epoch' });
  notice(socket, 'thread/realtime/transcript/delta', { threadId: 'existing-thread', role: 'assistant', delta: 'Hello' });
  notice(socket, 'thread/realtime/itemAdded', { threadId: 'existing-thread', item: { type: 'input_audio_buffer.speech_started', item_id: 'audio-1' } });
  await a.wait((message) => message.method === 'thread/realtime/itemAdded');
  assert.equal(a.messages.some((message) => JSON.stringify(message).includes('secret foreign text')), false);
  assert.equal(a.messages.some((message) => message.method === 'thread/realtime/closed'), false);
  assert.ok(a.messages.some((message) => message.params?.delta === 'Hello'));
  a.send({ type: 'hangup' }); await a.wait(isStatus('ended'));
  notice(socket, 'thread/realtime/transcript/delta', { threadId: 'existing-thread', role: 'assistant', delta: 'late audio' });
  await delay(15); assert.equal(a.messages.some((message) => message.params?.delta === 'late audio'), false);
});

test('unsupported server approvals fail closed and do not reveal request details', async (t) => {
  const f = await fixture(t); const a = await f.client(); start(a); await a.wait(isStatus('connected'));
  f.backendSockets[0].send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'existing-thread', command: 'cat secret-token' } }));
  await a.wait((message) => message.type === 'error' && /not approved/.test(message.message));
  await until(() => f.replies.length === 1);
  assert.equal(f.replies[0].error.code, -32601); assert.equal(f.replies[0].result, undefined);
  assert.equal(JSON.stringify(a.messages).includes('secret-token'), false);
});

test('backend errors are sanitized and browser cannot choose raw RPC or backend URL', async (t) => {
  const f = await fixture(t, { handler: (socket, request) => {
    if (request.method === 'thread/resume') { socket.send(JSON.stringify({ id: request.id, error: { code: -1, message: 'token=SUPER_SECRET ws://internal-host' } })); return true; }
  } });
  const a = await f.client();
  a.send({ type: 'rpc', method: 'process/spawn', params: {} }); await a.wait((message) => message.type === 'error');
  a.send({ type: 'call', contactId: 'agent', sdp: 'v=0\r\nvalid-looking-offer', url: 'ws://evil.example' });
  await delay(10); assert.equal(f.requests.length, 0);
  start(a); await a.wait(isStatus('ended'));
  assert.equal(JSON.stringify(a.messages).includes('SUPER_SECRET'), false);
  assert.equal(JSON.stringify(a.messages).includes('internal-host'), false);
  assert.equal(f.requests.some((request) => request.method === 'process/spawn'), false);
});

test('PCM accepts bounded real frames and forwards output and speech interruption', async (t) => {
  const f = await fixture(t, { contacts: [contact({ transport: 'pcm' })] });
  const a = await f.client(); a.send({ type: 'call', contactId: 'agent' }); await a.wait(isStatus('connected'));
  const audio = { data: Buffer.alloc(480 * 2).toString('base64'), sampleRate: 24000, numChannels: 1, samplesPerChannel: 480 };
  assert.equal(validAudio(audio), true); assert.equal(validAudio({ ...audio, samplesPerChannel: 481 }), false);
  a.send({ type: 'audio', audio }); await until(() => f.requests.some((request) => request.method === 'thread/realtime/appendAudio'));
  const startRequest = f.requests.find((request) => request.method === 'thread/realtime/start'); assert.equal(startRequest.params.transport, undefined);
  notice(f.backendSockets[0], 'thread/realtime/outputAudio/delta', { threadId: 'existing-thread', audio });
  await a.wait((message) => message.method === 'thread/realtime/outputAudio/delta');
  a.send({ type: 'audio', audio: { ...audio, samplesPerChannel: 481 } }); await a.wait(isStatus('ended'));
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/appendAudio').length, 1);
});

test('a start result arriving after timeout triggers final stop and safely clears quarantine', async (t) => {
  let deferred;
  const f = await fixture(t, { backendTimeout: 50, handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { deferred = { socket, request }; return true; }
  } });
  const a = await f.client(); start(a); await a.wait(isStatus('ended'));
  assert.equal(f.gateway.leases.size, 1);
  const before = f.requests.filter((request) => request.method === 'thread/realtime/stop').length;
  reply(deferred.socket, deferred.request);
  await until(() => f.gateway.leases.size === 0);
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/stop').length, before + 1);
  assert.equal(a.messages.some(isStatus('connected')), false);
});

test('delayed started event after timeout is stopped even before the late result arrives', async (t) => {
  let deferred;
  const f = await fixture(t, { backendTimeout: 50, handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { deferred = { socket, request }; return true; }
  } });
  const a = await f.client(); start(a); await a.wait(isStatus('ended'));
  const before = f.requests.filter((request) => request.method === 'thread/realtime/stop').length;
  notice(deferred.socket, 'thread/realtime/started', { threadId: 'existing-thread', realtimeSessionId: deferred.request.params.realtimeSessionId });
  await until(() => f.requests.filter((request) => request.method === 'thread/realtime/stop').length > before);
  assert.equal(f.gateway.leases.size, 1);
  reply(deferred.socket, deferred.request); await until(() => f.gateway.leases.size === 0);
});

test('call with no started notification times out and releases its confirmed stopped lease', async (t) => {
  const f = await fixture(t, { startupTimeout: 50, handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { reply(socket, request); return true; }
  } });
  const a = await f.client(); start(a); await a.wait(isStatus('ended'));
  assert.equal(a.messages.some(isStatus('connected')), false);
  assert.equal(f.gateway.leases.size, 0);
});

test('disconnect during pending start still stops after startup settles', async (t) => {
  let deferred;
  const f = await fixture(t, { handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { deferred = { socket, request }; return true; }
  } });
  const a = await f.client(); start(a); await until(() => deferred); a.socket.terminate();
  await until(() => f.requests.some((request) => request.method === 'thread/realtime/stop'));
  reply(deferred.socket, deferred.request); await until(() => f.gateway.leases.size === 0);
  assert.equal(f.requests.filter((request) => request.method === 'thread/realtime/stop').length, 2);
  assert.equal(f.backendSockets[0].readyState, WebSocket.OPEN);
});

test('oversized and binary browser frames are rejected without raw RPC forwarding', async (t) => {
  const f = await fixture(t);
  const a = await f.client(); const closedA = once(a.socket, 'close'); a.socket.send('x'.repeat(256 * 1024 + 1));
  assert.equal((await closedA)[0], 1009);
  const b = await f.client(); const closedB = once(b.socket, 'close'); b.socket.send(Buffer.from([1, 2]));
  assert.equal((await closedB)[0], 1003);
  assert.equal(f.requests.length, 0);
});

test('an explicitly rejected start does not stop an unrelated pre-existing realtime session', async (t) => {
  const f = await fixture(t, { handler: (socket, request) => {
    if (request.method === 'thread/realtime/start') { socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'A session already exists' } })); return true; }
  } });
  const a = await f.client(); start(a); await a.wait(isStatus('ended'));
  assert.equal(f.gateway.leases.size, 0);
  assert.equal(f.requests.some((request) => request.method === 'thread/realtime/stop'), false);
});
