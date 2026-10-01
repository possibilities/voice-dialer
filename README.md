# Threadline — voice dialer

A small, local web phone for existing Codex app-server threads. Choose a contact, call, mute, hang up, or switch threads. A contact is a configured app-server plus an existing thread ID; several contacts can share a server.

Supports the common experimental realtime API in vanilla Codex and the [Codex / OpenCode bridge fork](https://github.com/possibilities/codex/tree/voice/opencode-v2). The OpenCode backend stays behind that bridge: this browser does not impersonate its protocol or call OpenCode directly.

## Run

Node.js 22 or newer and a recent Codex app-server with realtime access are required.

```sh
npm ci --ignore-scripts
cp config.example.json config.json
# Edit the example paths, servers and existing thread IDs.
npm start
```

Open `http://127.0.0.1:4310` in a browser **on the same computer**. The microphone opens only after you press Call. Browser microphone permission is required. Headphones help avoid echo. The Speaker button resumes browser-blocked remote playback.

Configuration is server-side JSON, not a web-editable endpoint. `config.json`, local configs, environment files and `.runtime/` are git-ignored. Do not commit real thread IDs, project details or credentials.

### App-server endpoints

Start native Codex on loopback, preserving its normal authentication and security configuration:

```sh
codex -c features.realtime_conversation=true app-server --listen ws://127.0.0.1:4500
```

Configure `servers.codex.url` to that endpoint. This app-server WebSocket transport is experimental. Its listener intentionally rejects browser Origin headers, so the dialer gateway makes the upstream connection; the browser never connects directly to the app-server.

Alternatively a server entry can use `command` and `args` to launch one long-lived stdio app-server:

```json
{"command":"codex","args":["-c","features.realtime_conversation=true","app-server"]}
```

Each configured server has a single initialized connection. Hanging up stops only the realtime session. It does not kill that server, delete a thread, or interrupt backing-agent work. Stopping the gateway itself terminates child processes that the gateway launched; independently launched WebSocket backends remain running.

### Existing threads

Get IDs from your controlling app-server client. The dialer resumes the exact configured thread; it does not silently create a substitute when an ID is wrong. An ordinary persisted thread must be accessible to that app-server's own `CODEX_HOME`. In-memory ephemeral threads exist only inside the backend process that created them.

The example intentionally contains placeholder IDs. It is a configuration guide, not a working pair of authenticated demo agents.

### OpenCode fork

Use both compatible forks and follow the [bridge instructions](https://github.com/possibilities/codex/tree/voice/opencode-v2/external-orchestrator-bridge). Launch patched OpenCode on loopback, configure its provider through its supported authentication flow, then run the stdio bridge as the dialer's server entry. `CODEX_COMMAND` points to the patched Codex executable; the bridge appends `app-server` itself. A standalone `codex-app-server` build needs an explicit wrapper that validates/removes that argument.

The bridge routes agent work to OpenCode and handles external orchestration, startup context, lifecycle identities and feedback. Do not set `externalOrchestrator` yourself in the browser. A host Codex thread ID is required, not an OpenCode session ID.

Node subprocesses inherit standard system variables and sandbox markers. Other variables must be explicitly referenced in the trusted server config:

```json
{"env":{"OPENCODE_SERVER_PASSWORD":{"fromEnv":"OPENCODE_SERVER_PASSWORD"}}}
```

Values are read from the gateway process environment. Embedded password/token values are not accepted by the config schema. Never put credentials in a URL, browser config, source file or logs. Codex authentication does not automatically authenticate OpenCode.

## Audio transports

- `webrtc`: Browser microphone track + `oai-events` data channel are created before the real SDP offer. The gateway calls `thread/realtime/start`, and the browser applies the asynchronous `thread/realtime/sdp` answer. WebRTC carries media. V1 or V3 are supported by the inspected native API; V2 is rejected.
- `pcm`: An AudioWorklet captures mono PCM16 little-endian at 24 kHz when supported. Its actual AudioContext sample rate is sent with each chunk. The gateway uses `thread/realtime/appendAudio`; `thread/realtime/outputAudio/delta` drives bounded Web Audio playback. `input_audio_buffer.speech_started` clears queued playback for barge-in. No ScriptProcessor fallback.

Realtime model, version and optional prompt can be supplied per contact through `realtime`. Omit overrides to use backend defaults. Newer or differently configured app-servers may have different entitlement, model or protocol requirements; a mock pass is not evidence of live audio access.

## Lifecycle and safety

- Cancel works during microphone permission, ICE gathering, backend initialization and realtime startup
- Late permissions, SDP answers and old client events cannot revive a cancelled call
- Mute disables browser audio tracks and suppresses PCM upload
- Hangup immediately stops browser capture/playback, then confirms native realtime stop
- Thread leases prevent simultaneous calls to the same server/thread, including aliases
- Uncertain startup/stop quarantines that thread rather than risking a new call being stopped by old cleanup
- Backend requests are bounded by timeouts, payload sizes and backpressure
- No generic RPC tunnel or arbitrary browser-selected backend URLs
- Exact local Host/Origin checking, CSP and loopback binding defend the local gateway against ordinary cross-site requests and DNS rebinding
- This is a trusted-local, single-user tool. It has no internet login, reverse proxy support or remote-server authentication configuration. Do not expose or tunnel it as a public service
- No microphone recordings or transcript history are saved by the dialer. Transcripts are displayed in bounded browser memory; Codex/OpenCode and upstream providers retain data according to their own settings and policies

The voice-only UI cannot approve agent permissions, answer tool questions, enter credentials or render native approval widgets. Unsupported requests fail closed and end the call with a visible notice. Use an approval-capable controlling client; nothing is automatically approved.

## Development

```sh
npm run check
npm test
```

Node's built-in test runner exercises browser call resource ownership with fake media/peer/socket objects and gateway behavior against local fake JSON-RPC app-servers. GitHub Actions runs Node 22 and 24. This does not replace real-microphone, speaker, provider-authentication, latency, echo and interruption testing.

No frontend bundler, framework or CDN is needed. `ws` is the only runtime dependency. The UI is responsive, keyboard-accessible and respects reduced-motion preferences.
