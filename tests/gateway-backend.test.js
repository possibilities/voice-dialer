import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Backend } from '../src/backend.js';
import { createGateway } from '../src/server.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 1500; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await delay(5); } }

test('stdio command process and bridge state survive repeated hangups, then close on gateway shutdown', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dialer-stdio-'));
  const program = path.join(directory, 'server.mjs');
  const log = path.join(directory, 'requests.jsonl');
  await writeFile(program, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stderr.write('backend-secret: do-not-forward\\n');
createInterface({input:process.stdin}).on('line',(line)=>{
const r=JSON.parse(line);appendFileSync(process.argv[2],JSON.stringify(r)+'\\n');
if(r.id===undefined)return;
send({id:r.id,result:{}});
if(r.method==='thread/realtime/start')send({method:'thread/realtime/started',params:{threadId:r.params.threadId,realtimeSessionId:r.params.realtimeSessionId}});
});`);
  const config = { servers: { bridge: { command: process.execPath, args: [program, log] } }, contacts: [{ id: 'bridge', name: 'Bridge', server: 'bridge', threadId: 'thread-id', transport: 'pcm' }] };
  const gateway = createGateway({ config });
  const address = await gateway.listen({ port: 0 });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/call`, { origin: `http://127.0.0.1:${address.port}` });
  socket.on('error', () => {});
  const messages = []; socket.on('message', (raw) => messages.push(JSON.parse(raw)));
  await once(socket, 'open');
  let child;
  for (let call = 1; call <= 2; call++) {
    socket.send(JSON.stringify({ type: 'call', contactId: 'bridge' }));
    await until(() => messages.filter((message) => message.status === 'connected').length === call);
    const current = gateway.backends.get('bridge').child;
    if (child) assert.equal(current.pid, child.pid); else child = current;
    socket.send(JSON.stringify({ type: 'hangup' }));
    await until(() => messages.filter((message) => message.status === 'ended').length === call);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  }
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter((request) => request.method === 'initialize').length, 1);
  assert.equal(requests.filter((request) => request.method === 'thread/resume').length, 2);
  assert.equal(requests.filter((request) => request.method === 'thread/realtime/start').length, 2);
  assert.equal(JSON.stringify(messages).includes('backend-secret'), false);
  const exited = once(child, 'exit'); await gateway.close(); await exited;
  assert.notEqual(child.signalCode, null);
});

test('concurrent backend callers share one initialize handshake and sanitized RPC errors', async (t) => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(fake, 'listening');
  const requests = [];
  fake.on('connection', (socket) => socket.on('message', (raw) => {
    const request = JSON.parse(raw); requests.push(request);
    if (request.id === undefined) return;
    if (request.method === 'bad') socket.send(JSON.stringify({ id: request.id, error: { message: 'secret: example-token' } }));
    else socket.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  const backend = new Backend({ url: `ws://127.0.0.1:${fake.address().port}` });
  t.after(async () => { backend.close(); for (const socket of fake.clients) socket.terminate(); await new Promise((resolve) => fake.close(resolve)); });
  await Promise.all([backend.connect(), backend.connect(), backend.connect()]);
  assert.equal(requests.filter((request) => request.method === 'initialize').length, 1);
  await assert.rejects(backend.request('bad', {}), (error) => error.code === 'rpc' && !error.message.includes('secret'));
});

test('malformed JSON backend frames close transport and reject pending requests', async (t) => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(fake, 'listening');
  fake.on('connection', (socket) => socket.on('message', () => socket.send('invalid-json')));
  const backend = new Backend({ url: `ws://127.0.0.1:${fake.address().port}` }, { timeoutMs: 100 });
  t.after(async () => { backend.close(); for (const socket of fake.clients) socket.terminate(); await new Promise((resolve) => fake.close(resolve)); });
  await assert.rejects(backend.connect(), /disconnected/);
  assert.equal(backend.pending.size, 0);
});

test('backend can reconnect after transport loss without old socket state or duplicate initialization', async (t) => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(fake, 'listening');
  let connections = 0, initializations = 0;
  fake.on('connection', (socket) => {
    connections++;
    socket.on('message', (raw) => {
      const request = JSON.parse(raw);
      if (request.method === 'initialize') initializations++;
      if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  const backend = new Backend({ url: `ws://127.0.0.1:${fake.address().port}` });
  t.after(async () => { backend.close(); for (const socket of fake.clients) socket.terminate(); await new Promise((resolve) => fake.close(resolve)); });
  await backend.connect();
  const disconnected = once(backend, 'disconnect');
  [...fake.clients][0].terminate(); await disconnected;
  assert.equal(backend.ws, null); assert.equal(backend.alive, false);
  await backend.connect();
  assert.equal(backend.ready, true); assert.equal(connections, 2); assert.equal(initializations, 2);
  assert.deepEqual(await backend.request('test', {}), {});
});
