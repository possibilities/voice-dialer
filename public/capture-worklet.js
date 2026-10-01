class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new ArrayBuffer(2048); this.view = new DataView(this.buffer); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      const clamped = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true); this.offset += 2;
      if (this.offset === this.buffer.byteLength) {
        this.port.postMessage(this.buffer, [this.buffer]);
        this.buffer = new ArrayBuffer(2048); this.view = new DataView(this.buffer); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
