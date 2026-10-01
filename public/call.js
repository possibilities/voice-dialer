import { PcmAudio } from './pcm.js';

/** One browser call owns every media resource. A cancelled attempt cannot revive itself. */
export class VoiceCall {
  constructor(contact, { onState = () => {}, onTranscript = () => {}, onNotice = () => {},
    mediaDevices = navigator.mediaDevices, Peer = globalThis.RTCPeerConnection,
    Socket = globalThis.WebSocket, audioElement, socketUrl,
    createPcm = (stream, send) => new PcmAudio(stream, send) } = {}) {
    Object.assign(this, { contact, onState, onTranscript, onNotice, mediaDevices, Peer, Socket, audioElement, socketUrl, createPcm });
    this.cancelled = false; this.muted = false; this.state = 'idle'; this.sentCall = false;
    this.serverStarted = false; this.timers = new Set();
  }
  setState(state, detail = '') { this.state = state; this.onState({ state, detail, muted: this.muted }); }
  later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); return timer; }
  clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  async start() {
    if (this.state !== 'idle') return;
    this.setState('permission', 'Allow microphone access to start your call');
    try {
      if (!this.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS or localhost in a supported browser');
      const stream = await this.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (this.cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener?.('ended', () => { if (!this.cancelled) this.fail('Microphone disconnected'); });
      let sdp;
      if (this.contact.transport === 'pcm') {
        this.pcm = this.createPcm(stream, audio => {
          if (!this.cancelled && !this.muted && this.serverStarted) this.send({ type: 'audio', audio });
        });
        await this.pcm.start();
        if (this.cancelled) { await this.pcm.close(); return; }
      } else {
        this.pc = new this.Peer();
        for (const track of stream.getAudioTracks()) this.pc.addTrack(track, stream);
        this.channel = this.pc.createDataChannel('oai-events');
        this.pc.ontrack = ({ streams, track }) => {
          if (this.cancelled || !this.audioElement) return;
          this.audioElement.srcObject = streams[0] || new MediaStream([track]);
          this.audioElement.play().catch(() => this.onNotice('Your browser paused playback. Press Speaker.'));
        };
        this.pc.onconnectionstatechange = () => {
          if (this.cancelled) return;
          const state = this.pc.connectionState;
          if (state === 'connected') this.setState('connected', 'You’re connected');
          if (state === 'failed' || state === 'closed') this.fail('Audio connection ended');
          if (state === 'disconnected') {
            this.setState('reconnecting', 'Audio connection interrupted');
            this.later(() => { if (!this.cancelled && this.pc?.connectionState === 'disconnected') this.fail('Audio connection was lost'); }, 8000);
          }
        };
        const offer = await this.pc.createOffer();
        if (this.cancelled) return;
        await this.pc.setLocalDescription(offer);
        if (this.cancelled) return;
        // App-server forwards one SDP document; it has no trickle-ICE RPC.
        await this.waitForIce();
        if (this.cancelled) return;
        sdp = this.pc.localDescription.sdp;
      }
      this.setState('connecting', 'Calling your thread…');
      this.socket = new this.Socket(this.socketUrl);
      this.socket.onopen = () => {
        if (this.cancelled) { this.socket.close(); return; }
        this.sentCall = true;
        this.send({ type: 'call', contactId: this.contact.id, ...(sdp ? { sdp } : {}) });
      };
      this.socket.onmessage = event => { this.receive(event.data).catch(() => this.fail('Could not establish the audio connection')); };
      this.socket.onerror = () => { if (!this.cancelled) this.fail('Could not reach the dialer gateway'); };
      this.socket.onclose = () => {
        if (!this.cancelled) this.fail('The dialer connection closed');
        else this.finish();
      };
      this.later(() => { if (!this.cancelled && this.state !== 'connected') this.fail('Call setup timed out'); }, 45000);
    } catch (error) {
      if (this.cancelled) return;
      const friendly = error?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser, then call again.'
        : error?.name === 'NotFoundError' ? 'No microphone was found' : error?.message || 'Could not start the call';
      this.fail(friendly);
    }
  }
  waitForIce() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; this.pc?.removeEventListener('icegatheringstatechange', changed); this.iceResolve = null; resolve(); };
      const changed = () => { if (this.pc?.iceGatheringState === 'complete') finish(); };
      this.iceResolve = finish;
      this.pc.addEventListener('icegatheringstatechange', changed);
      this.later(finish, 2500);
    });
  }
  send(value) {
    if (this.socket?.readyState !== 1) return;
    if (this.socket.bufferedAmount > 256 * 1024) { this.fail('The connection is too slow for live audio'); return; }
    this.socket.send(JSON.stringify(value));
  }
  async receive(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'status' && message.status === 'ended') {
      if (!this.cancelled) { this.cancelled = true; this.releaseMedia(); }
      this.finish(); return;
    }
    if (this.cancelled) return;
    if (message.type === 'error') { this.fail(message.message || 'The backend could not start the call'); return; }
    if (message.type === 'notice') { this.onNotice(message.message); return; }
    if (message.type === 'status' && message.status === 'connected') {
      this.serverStarted = true;
      if (this.contact.transport === 'pcm') this.setState('connected', 'You’re connected');
    }
    if (message.type !== 'notification') return;
    const { method, params = {} } = message;
    if (method === 'thread/realtime/sdp' && this.pc) {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: params.sdp });
      return;
    }
    if (method === 'thread/realtime/started') { this.serverStarted = true; if (this.contact.transport === 'pcm') this.setState('connected', 'You’re connected'); }
    if (method === 'thread/realtime/error') this.fail(params.message || 'The realtime backend reported an error');
    if (method === 'thread/realtime/closed') this.hangup();
    if (method === 'thread/realtime/outputAudio/delta') this.pcm?.play(params.audio);
    if (method === 'thread/realtime/itemAdded' && params.item?.type === 'input_audio_buffer.speech_started') this.pcm?.clearPlayback();
    if (method === 'thread/realtime/transcript/delta') this.onTranscript({ role: params.role, delta: params.delta });
    if (method === 'thread/realtime/transcript/done') this.onTranscript({ role: params.role, text: params.text, done: true });
  }
  async resumePlayback() {
    if (this.cancelled) return;
    if (this.pcm) await this.pcm.context?.resume();
    else await this.audioElement?.play();
  }
  toggleMute() {
    if (this.cancelled || !this.stream) return;
    this.muted = !this.muted;
    this.stream.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    this.setState(this.state, this.muted ? 'Microphone muted' : 'Microphone on');
  }
  fail(message) { this.onNotice(message); this.hangup(); }
  hangup() {
    if (this.cancelled) return this.ended || Promise.resolve();
    this.cancelled = true; this.setState('ending', 'Ending call…'); this.clearTimers();
    this.ended = new Promise(resolve => { this.resolveEnded = resolve; });
    this.releaseMedia();
    if (this.sentCall && this.socket?.readyState === 1) {
      this.send({ type: 'hangup' });
      this.later(() => this.finish(), 12000);
    } else this.finish();
    return this.ended;
  }
  releaseMedia() {
    this.iceResolve?.();
    this.stream?.getTracks().forEach(t => t.stop());
    this.channel?.close(); this.pc?.close();
    this.pcm?.close().catch(() => {});
    if (this.audioElement) { this.audioElement.pause(); this.audioElement.srcObject = null; }
  }
  finish() {
    this.clearTimers();
    if (this.socket && this.socket.readyState < 2) this.socket.close();
    this.setState('ended', 'Call ended');
    this.resolveEnded?.();
  }
}
