import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PcmAudio } from '../public/pcm.js';

test('AudioWorklet packs clipped little-endian PCM16 chunks with transferable ownership',async()=>{
 let Capture;const messages=[];
 const context=vm.createContext({AudioWorkletProcessor:class{constructor(){this.port={postMessage:(buffer,transfers)=>messages.push({buffer,transfers})};}},registerProcessor:(name,ctor)=>{assert.equal(name,'pcm-capture');Capture=ctor;},ArrayBuffer,DataView});
 vm.runInContext(await readFile(new URL('../public/capture-worklet.js',import.meta.url),'utf8'),context);
 const capture=new Capture();const input=new Float32Array(1024);input.set([-2,-1,-.5,0,.5,1,2]);
 assert.equal(capture.process([[input]]),true);assert.equal(messages.length,1);assert.equal(messages[0].transfers[0],messages[0].buffer);
 const view=new DataView(messages[0].buffer);assert.deepEqual(Array.from({length:7},(_,i)=>view.getInt16(i*2,true)),[-32768,-32768,-16384,0,16383,32767,32767]);
 assert.notEqual(capture.buffer,messages[0].buffer);assert.equal(capture.offset,0);
});
test('PCM playback deinterleaves channels and barge-in clears queued sources',()=>{
 const pcm=new PcmAudio({},()=>{}),sources=[],buffers=[];
 pcm.context={currentTime:1,destination:{},createBuffer(channels,length,rate){const data=Array.from({length:channels},()=>new Float32Array(length));const buffer={duration:length/rate,getChannelData:c=>data[c],data};buffers.push(buffer);return buffer;},createBufferSource(){const source={connect(){},disconnect(){this.disconnected=true;},start(time){this.time=time;},stop(){this.stopped=true;}};sources.push(source);return source;}};
 const bytes=Buffer.alloc(8);[-32768,32767,16384,-16384].forEach((n,i)=>bytes.writeInt16LE(n,i*2));
 pcm.play({data:bytes.toString('base64'),sampleRate:24000,numChannels:2});
 assert.deepEqual([...buffers[0].data[0]],[-1,.5]);assert.deepEqual([...buffers[0].data[1]],[32767/32768,-.5]);assert.equal(sources[0].time,1.02);
 pcm.clearPlayback();assert.equal(sources[0].stopped,true);assert.equal(sources[0].disconnected,true);assert.equal(pcm.sources.size,0);assert.equal(pcm.nextTime,0);
 pcm.play({data:'AA==',sampleRate:24000,numChannels:1});assert.equal(sources.length,1);
});
