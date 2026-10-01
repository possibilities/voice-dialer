import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createGateway } from '../src/server.js';

let backend, gateway, url, requests;
test.beforeEach(async () => {
  requests=[];
  backend=new WebSocketServer({host:'127.0.0.1',port:0});await once(backend,'listening');
  backend.on('connection',socket=>socket.on('message',raw=>{
    const request=JSON.parse(raw);requests.push(request);
    if(!request.id)return;
    const result=request.method==='thread/resume'?{thread:{id:request.params.threadId}}:{};
    socket.send(JSON.stringify({id:request.id,result}));
    if(request.method==='thread/realtime/start') {
      socket.send(JSON.stringify({method:'thread/realtime/started',params:{threadId:request.params.threadId,realtimeSessionId:request.params.realtimeSessionId}}));
      if(!request.params.transport) socket.send(JSON.stringify({method:'thread/realtime/transcript/done',params:{threadId:request.params.threadId,role:'assistant',text:'This is a local test fixture. No provider call was made.'}}));
    }
  }));
  gateway=createGateway({config:{servers:{mock:{url:`ws://127.0.0.1:${backend.address().port}`}},contacts:[
    {id:'codex',name:'Codex · Project',server:'mock',threadId:'private-test-thread-one',transport:'pcm'},
    {id:'opencode',name:'OpenCode · Studio',server:'mock',threadId:'private-test-thread-two',transport:'pcm'},
    {id:'webrtc',name:'WebRTC · Preview',server:'mock',threadId:'private-test-thread-three',transport:'webrtc'},
  ]}});
  const address=await gateway.listen({port:0});url=`http://127.0.0.1:${address.port}`;
});
test.afterEach(async()=>{
  await gateway?.close();
  for(const socket of backend.clients)socket.terminate();
  await new Promise(resolve=>backend.close(resolve));
});
async function open(page,context){
  await context.grantPermissions(['microphone'],{origin:url});
  await page.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.testTracks=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.testTracks.push(...stream.getTracks());return stream;};
  });
  await page.goto(url);await expect(page.locator('#contact-name')).toHaveText('Codex · Project');
}

test('responsive contacts render without exposing configured thread IDs',async({page,context},testInfo)=>{
  await open(page,context);
  await expect(page.locator('.contact')).toHaveCount(3);
  await expect(page.getByRole('heading',{name:'A conversation away.'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('private-test-thread');
  await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.phone')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('mobile.png'),fullPage:true});
});

test('PCM calls capture real browser fake-device audio, mute, hang up and redial another thread',async({page,context})=>{
  await open(page,context);await page.getByRole('button',{name:'Call selected contact'}).click();
  await expect(page.locator('#status-pill')).toHaveText('ON THE CALL');
  await expect.poll(()=>requests.filter(r=>r.method==='thread/realtime/appendAudio').length).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Mute microphone',exact:true}).click();
  expect(await page.evaluate(()=>window.testTracks.every(track=>track.enabled===false))).toBe(true);
  await expect(page.locator('#mute')).toHaveAttribute('aria-pressed','true');
  await page.locator('.contact').filter({hasText:'OpenCode · Studio'}).click();
  await expect(page.locator('#contact-name')).toHaveText('OpenCode · Studio');
  expect(await page.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended'))).toBe(true);
  await page.getByRole('button',{name:'Call selected contact'}).click();await expect(page.locator('#status-pill')).toHaveText('ON THE CALL');
  expect(requests.filter(r=>r.method==='thread/realtime/start').map(r=>r.params.threadId)).toEqual(['private-test-thread-one','private-test-thread-two']);
  await page.getByRole('button',{name:'Hang up call'}).click();await expect(page.locator('#status-pill')).toHaveText('CALL ENDED');
  expect(await page.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended'))).toBe(true);
});

test('WebRTC generates real audio+data SDP and can cancel before remote media connects',async({page,context})=>{
  await open(page,context);await page.locator('.contact').filter({hasText:'WebRTC · Preview'}).click();
  await page.getByRole('button',{name:'Call selected contact'}).click();
  await expect.poll(()=>requests.find(r=>r.method==='thread/realtime/start')?.params.transport?.sdp).toBeTruthy();
  const sdp=requests.find(r=>r.method==='thread/realtime/start').params.transport.sdp;
  expect(sdp).toContain('m=audio');expect(sdp).toContain('m=application');expect(sdp).toContain('a=ice-ufrag:');
  await expect(page.locator('#status-pill')).toHaveText('CONNECTING');
  await page.getByRole('button',{name:'Hang up call'}).click();await expect(page.locator('#status-pill')).toHaveText('CALL ENDED');
  expect(await page.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended'))).toBe(true);
});

test('denied microphone never opens an app-server call',async({page})=>{
  await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied by test','NotAllowedError');};});
  await page.goto(url);await page.getByRole('button',{name:'Call selected contact'}).click();
  await expect(page.locator('#notice')).toContainText('Microphone access was denied');
  await expect(page.locator('#status-pill')).toHaveText('CALL ENDED');
  expect(requests).toEqual([]);
});

test('hangup during microphone prompt disposes a late permission grant',async({page,context})=>{
  await context.grantPermissions(['microphone'],{origin:url});
  await page.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=constraints=>new Promise(resolve=>{window.releaseMicrophone=async()=>{const stream=await original(constraints);window.testTracks=stream.getTracks();resolve(stream);};});
  });
  await page.goto(url);await page.getByRole('button',{name:'Call selected contact'}).click();
  await expect(page.locator('#status-pill')).toHaveText('MICROPHONE');
  await page.getByRole('button',{name:'Hang up call'}).click();await expect(page.locator('#status-pill')).toHaveText('CALL ENDED');
  await page.evaluate(()=>window.releaseMicrophone());
  await expect.poll(()=>page.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended'))).toBe(true);
  expect(requests).toEqual([]);
});
