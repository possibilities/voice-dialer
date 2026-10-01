import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCall } from '../public/call.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function harness({ pendingMedia = false, pendingOffer = false, transport = 'webrtc' } = {}) {
  const track = { enabled:true, stopped:0, stop(){this.stopped++;}, addEventListener(){} };
  const stream = { getTracks:()=>[track], getAudioTracks:()=>[track] };
  const media = deferred(), offer = deferred(); const sockets=[], peers=[], states=[], notices=[], transcripts=[];
  class Peer {
    constructor(){peers.push(this);this.connectionState='new';this.iceGatheringState='complete';this.localDescription={sdp:'v=0\r\nreal mock offer'};}
    addTrack(t,s){this.track=t;this.stream=s;}
    createDataChannel(label){this.channel={label,closed:false,close(){this.closed=true;}};return this.channel;}
    async createOffer(){assert.equal(this.channel.label,'oai-events');assert.equal(this.track,track);return pendingOffer?offer.promise:{type:'offer',sdp:'v=0\r\nreal mock offer'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(value){this.remote=value;}
    close(){this.closed=true;this.connectionState='closed';this.onconnectionstatechange?.();}
  }
  class Socket {
    constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];sockets.push(this);}
    send(text){this.sent.push(JSON.parse(text));}
    close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.onclose?.());}
    open(){this.readyState=1;this.onopen();}
    receive(message){this.onmessage({data:JSON.stringify(message)});}
  }
  const audioElement={play:async()=>{},pause(){},srcObject:null};
  const pcm={started:0,closed:0,played:[],clear:0,async start(){this.started++;},async close(){this.closed++;},play(a){this.played.push(a);},clearPlayback(){this.clear++;}};
  let sendPcm;
  const call = new VoiceCall({id:'alpha',name:'Alpha',transport},{ mediaDevices:{getUserMedia:()=>pendingMedia?media.promise:Promise.resolve(stream)},Peer,Socket,audioElement,socketUrl:'ws://localhost:4310/call',onState:s=>states.push(s),onNotice:n=>notices.push(n),onTranscript:t=>transcripts.push(t),createPcm:(_stream,send)=>{sendPcm=send;return pcm;} });
  return {call,track,stream,media,offer,sockets,peers,states,notices,transcripts,audioElement,pcm,sendPcm:(a)=>sendPcm(a)};
}
async function end(h){const p=h.call.hangup();h.sockets[0]?.receive({type:'status',status:'ended'});await p;}

test('WebRTC call sends actual offer, applies answer, and waits for media connectivity',async()=>{
 const h=harness();await h.call.start();h.sockets[0].open();
 assert.deepEqual(h.sockets[0].sent,[{type:'call',contactId:'alpha',sdp:'v=0\r\nreal mock offer'}]);
 h.sockets[0].receive({type:'status',status:'connected'});assert.equal(h.call.state,'connecting');
 h.sockets[0].receive({type:'notification',method:'thread/realtime/sdp',params:{sdp:'answer'}});await flush();
 assert.deepEqual(h.peers[0].remote,{type:'answer',sdp:'answer'});
 h.peers[0].connectionState='connected';h.peers[0].onconnectionstatechange();assert.equal(h.call.state,'connected');
 h.call.toggleMute();assert.equal(h.track.enabled,false);h.call.toggleMute();assert.equal(h.track.enabled,true);
 await end(h);assert.equal(h.track.stopped,1);assert.equal(h.peers[0].closed,true);assert.equal(h.call.state,'ended');
});
test('hangup while microphone permission is pending stops tracks on late grant',async()=>{
 const h=harness({pendingMedia:true});const start=h.call.start();await h.call.hangup();h.media.resolve(h.stream);await start;
 assert.equal(h.track.stopped,1);assert.equal(h.sockets.length,0);assert.equal(h.call.state,'ended');
});
test('hangup while offer is pending cannot create a later call socket',async()=>{
 const h=harness({pendingOffer:true});const start=h.call.start();await flush();await h.call.hangup();h.offer.resolve({type:'offer',sdp:'late'});await start;
 assert.equal(h.sockets.length,0);assert.equal(h.peers[0].closed,true);assert.equal(h.track.stopped,1);
});
test('permission denial is actionable and creates no backend socket',async()=>{
 const h=harness({pendingMedia:true});const start=h.call.start();h.media.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));await start;
 assert.match(h.notices[0],/denied/);assert.equal(h.sockets.length,0);assert.equal(h.call.state,'ended');
});
test('late SDP and transcript after cancellation never revive old call',async()=>{
 const h=harness();await h.call.start();h.sockets[0].open();const done=h.call.hangup();
 h.sockets[0].receive({type:'notification',method:'thread/realtime/sdp',params:{sdp:'late'}});
 h.sockets[0].receive({type:'notification',method:'thread/realtime/transcript/delta',params:{role:'assistant',delta:'late'}});await flush();
 assert.equal(h.peers[0].remote,undefined);assert.deepEqual(h.transcripts,[]);
 h.sockets[0].receive({type:'status',status:'ended'});await done;assert.equal(h.call.state,'ended');
});
test('socket loss immediately closes microphone and peer',async()=>{
 const h=harness();await h.call.start();h.sockets[0].open();h.sockets[0].close();await flush();
 assert.equal(h.track.stopped,1);assert.equal(h.peers[0].closed,true);assert.equal(h.call.state,'ended');assert.match(h.notices[0],/closed/);
});
test('PCM chunks wait for start, mute suppresses upload, barge-in clears playback',async()=>{
 const h=harness({transport:'pcm'});await h.call.start();h.sockets[0].open();
 h.sendPcm({data:'AA=='});assert.equal(h.sockets[0].sent.length,1);
 h.sockets[0].receive({type:'status',status:'connected'});h.sendPcm({data:'AA=='});assert.equal(h.sockets[0].sent.length,2);
 h.call.toggleMute();h.sendPcm({data:'AA=='});assert.equal(h.sockets[0].sent.length,2);assert.equal(h.track.enabled,false);
 h.sockets[0].receive({type:'notification',method:'thread/realtime/outputAudio/delta',params:{audio:{data:'AA=='}}});
 h.sockets[0].receive({type:'notification',method:'thread/realtime/itemAdded',params:{item:{type:'input_audio_buffer.speech_started'}}});
 assert.equal(h.pcm.played.length,1);assert.equal(h.pcm.clear,1);await end(h);assert.equal(h.pcm.closed,1);
});
test('duplicate call start is ignored and repeated hangup is safe',async()=>{
 const h=harness();await h.call.start();await h.call.start();assert.equal(h.sockets.length,1);h.sockets[0].open();
 const a=h.call.hangup(),b=h.call.hangup();assert.equal(a,b);assert.equal(h.sockets[0].sent.filter(v=>v.type==='hangup').length,1);
 h.sockets[0].receive({type:'status',status:'ended'});await a;
});
