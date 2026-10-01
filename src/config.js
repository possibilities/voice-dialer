import { readFile } from 'node:fs/promises';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
function fail(message) { throw new Error(`Invalid dialer configuration: ${message}`); }
function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`unsupported ${name} field`);
}
export function isLoopback(host) { return LOOPBACK.has(host); }

/** Only this local, trusted configuration can choose an executable or destination. */
export function validateConfig(input) {
  keys(input, ['host', 'port', 'servers', 'contacts'], 'root');
  const host = input.host ?? '127.0.0.1';
  const port = input.port ?? 4310;
  if (!isLoopback(host)) fail('host must be loopback');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port must be between 1 and 65535');
  if (!object(input.servers) || Object.keys(input.servers).length > 32) fail('servers must be an object with at most 32 entries');
  const servers = Object.create(null);
  for (const [name, server] of Object.entries(input.servers)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) fail('invalid server name');
    keys(server, ['url', 'command', 'args', 'env'], 'server');
    if (own(server, 'url')) {
      if (own(server, 'command') || own(server, 'args') || own(server, 'env')) fail('choose url or command for each server');
      let url;
      try { url = new URL(server.url); } catch { fail('invalid server URL'); }
      if (url.protocol !== 'ws:' || !isLoopback(url.hostname) || url.username || url.password || url.search || url.hash) fail('server URLs must be credential-free loopback ws URLs');
      servers[name] = { url: url.href };
    } else {
      if (!bounded(server.command, 4096)) fail('command must be one executable');
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 100 || server.args.some((arg) => !bounded(arg, 8192)))) fail('invalid command arguments');
      const env = Object.create(null);
      if (server.env !== undefined) {
        if (!object(server.env) || Object.keys(server.env).length > 100) fail('invalid env references');
        for (const [key, reference] of Object.entries(server.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail('invalid environment name');
          keys(reference, ['fromEnv'], 'env reference');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.fromEnv ?? '')) fail('env values must use {fromEnv:"VARIABLE_NAME"}');
          env[key] = { fromEnv: reference.fromEnv };
        }
      }
      servers[name] = { command: server.command, args: [...(server.args ?? [])], env };
    }
  }
  if (!Array.isArray(input.contacts) || input.contacts.length > 200) fail('contacts must be an array with at most 200 entries');
  const ids = new Set();
  const contacts = input.contacts.map((contact) => {
    keys(contact, ['id', 'name', 'server', 'threadId', 'transport', 'realtime'], 'contact');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(contact.id ?? '') || ids.has(contact.id)) fail('contact IDs must be unique');
    ids.add(contact.id);
    if (!bounded(contact.name, 120) || !bounded(contact.threadId, 256) || !own(servers, contact.server)) fail('contact requires a name, existing threadId, and configured server');
    if (!['webrtc', 'pcm'].includes(contact.transport)) fail('contact transport must be webrtc or pcm');
    const realtime = {};
    if (contact.realtime !== undefined) {
      keys(contact.realtime, ['version', 'model', 'prompt'], 'realtime');
      if (own(contact.realtime, 'version')) {
        if (!['v1', 'v2', 'v3'].includes(contact.realtime.version)) fail('invalid realtime version');
        if (contact.transport === 'webrtc' && contact.realtime.version === 'v2') fail('realtime v2 does not support WebRTC');
        realtime.version = contact.realtime.version;
      }
      if (own(contact.realtime, 'model')) {
        if (!bounded(contact.realtime.model, 200)) fail('invalid realtime model');
        realtime.model = contact.realtime.model;
      }
      if (own(contact.realtime, 'prompt')) {
        if (contact.realtime.prompt !== null && (typeof contact.realtime.prompt !== 'string' || contact.realtime.prompt.length > 32768)) fail('invalid realtime prompt');
        realtime.prompt = contact.realtime.prompt;
      }
    }
    return { id: contact.id, name: contact.name, server: contact.server, threadId: contact.threadId, transport: contact.transport, realtime };
  });
  return { host: host === '[::1]' ? '::1' : host, port, servers, contacts };
}

export async function loadConfig(filename) {
  let contents;
  try { contents = await readFile(filename, 'utf8'); } catch { throw new Error('Cannot read dialer configuration file'); }
  if (Buffer.byteLength(contents) > 1024 * 1024) fail('file exceeds 1 MiB');
  let input;
  try { input = JSON.parse(contents); } catch { fail('file must be valid JSON'); }
  return validateConfig(input);
}

export function childEnvironment(references = {}, source = process.env) {
  const env = {};
  // Do not implicitly forward every secret in the gateway environment.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CODEX_HOME', 'CODEX_SQLITE_HOME']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [target, { fromEnv }] of Object.entries(references)) {
    if (source[fromEnv] === undefined) throw new Error('A configured environment variable is missing');
    env[target] = source[fromEnv];
  }
  // Mandatory sandbox markers must survive and cannot be overridden by a reference.
  for (const key of ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
