/** PCM16 little-endian audio; audio itself stays in memory and is never recorded. */
export class PcmAudio {
  constructor(stream, send) { this.stream = stream; this.send = send; this.sources = new Set(); this.closed = false; this.nextTime = 0; }
  async start() {
    this.context = new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
    await this.context.audioWorklet.addModule('/capture-worklet.js');
    if (this.closed) return;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture');
    this.silence = this.context.createGain(); this.silence.gain.value = 0;
    this.node.port.onmessage = ({ data }) => {
      if (this.closed) return;
      const bytes = new Uint8Array(data);
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      this.send({ data: btoa(binary), sampleRate: this.context.sampleRate, numChannels: 1, samplesPerChannel: bytes.length / 2 });
    };
    this.input.connect(this.node); this.node.connect(this.silence); this.silence.connect(this.context.destination);
  }
  play(audio) {
    if (this.closed || !audio || typeof audio.data !== 'string' || audio.data.length > 1024 * 1024) return;
    const channels = audio.numChannels; const rate = audio.sampleRate;
    if (!Number.isInteger(channels) || channels < 1 || channels > 2 || rate < 8000 || rate > 96000) return;
    const raw = atob(audio.data); const length = raw.length / (channels * 2);
    if (!Number.isInteger(length) || length < 1 || length / rate > 5) return;
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)); const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(channels, length, rate);
    for (let c = 0; c < channels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < length; i++) data[i] = view.getInt16((i * channels + c) * 2, true) / 32768; }
    if (this.nextTime > this.context.currentTime + 5) this.clearPlayback();
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source); this.nextTime = Math.max(this.nextTime, this.context.currentTime + .02);
    source.start(this.nextTime); this.nextTime += buffer.duration;
  }
  clearPlayback() { for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); } this.sources.clear(); this.nextTime = 0; }
  async close() {
    if (this.closed) return; this.closed = true;
    this.clearPlayback(); this.input?.disconnect(); this.node?.disconnect(); this.silence?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
