import { VoiceCall } from './call.js';
const $ = id => document.getElementById(id);
let contacts = [], selected, call, switching = false, startedAt = 0, transcriptItems = [], pendingText = new Map();
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function initials(name) { return name.trim().split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase(); }
function renderContacts() {
  $('contact-count').textContent = contacts.length;
  $('contacts').replaceChildren();
  for (const contact of contacts) {
    const button = document.createElement('button'); button.className = `contact${selected?.id === contact.id ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(selected?.id === contact.id));
    const avatar = document.createElement('span'); avatar.className = 'contact-avatar'; avatar.textContent = initials(contact.name);
    const info = document.createElement('span'); info.className = 'contact-info';
    const name = document.createElement('span'); name.className = 'contact-name'; name.textContent = contact.name;
    const meta = document.createElement('span'); meta.className = 'contact-meta'; meta.textContent = contact.transport === 'pcm' ? 'App-server · PCM audio' : 'App-server · WebRTC audio';
    const arrow = document.createElement('span'); arrow.className = 'contact-arrow'; arrow.textContent = '↗';
    info.append(name, meta); button.append(avatar, info, arrow); button.addEventListener('click', () => select(contact));
    $('contacts').append(button);
  }
  if (!contacts.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No contacts configured. Add an app-server and existing thread ID to the server config, then restart the gateway.'; $('contacts').append(p); }
}
async function select(contact) {
  if (switching) return;
  if (call && call.state !== 'ended') {
    switching = true; $('call').disabled = true;
    await call.hangup(); switching = false;
  }
  selected = contact; call = null; startedAt = 0;
  $('avatar').textContent = initials(contact.name); $('contact-name').textContent = contact.name;
  renderContacts(); updateState({ state:'idle', detail:'Ready when you are' });
}
function updateState({ state, detail, muted = false }) {
  const active = !['idle','ended'].includes(state);
  const states = {idle:'READY TO CALL',permission:'MICROPHONE',connecting:'CONNECTING',connected:'ON THE CALL',reconnecting:'RECONNECTING',ending:'ENDING CALL',ended:'CALL ENDED'};
  $('status-pill').textContent = states[state] || state; $('call-detail').textContent = detail;
  document.querySelector('.phone').classList.toggle('live', state === 'connected' && !muted);
  $('call').classList.toggle('hangup', active); $('call-label').textContent = active ? 'Hang up' : 'Call';
  $('call').setAttribute('aria-label', active ? 'Hang up call' : 'Call selected contact');
  $('call').disabled = !selected || switching || state === 'ending';
  $('mute').disabled = !['connected','reconnecting','connecting'].includes(state);
  $('mute').setAttribute('aria-pressed', String(muted)); $('mute').setAttribute('aria-label', muted?'Unmute microphone':'Mute microphone');
  $('mute-label').textContent = muted ? 'Unmute' : 'Mute';
  if (state === 'connected' && !startedAt) startedAt = Date.now();
  if (state === 'idle') $('timer').textContent = '00:00';
}
function transcript(event) {
  const role = event.role === 'user' ? 'You' : 'Assistant';
  let item = pendingText.get(role);
  if (!item) { item = { role, text:'' }; transcriptItems.push(item); pendingText.set(role,item); }
  if (event.done) { item.text = event.text || item.text; pendingText.delete(role); }
  else item.text += event.delta || '';
  // Bounded in-memory display; no localStorage, cookies, or server transcript logging.
  transcriptItems = transcriptItems.slice(-100);
  $('transcript').replaceChildren();
  for (const entry of transcriptItems) { const p=document.createElement('p'), who=document.createElement('strong'); who.textContent=entry.role; p.append(who,document.createTextNode(entry.text.slice(-20000))); $('transcript').append(p); }
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
$('call').addEventListener('click', () => {
  if (call && call.state !== 'ended') { call.hangup(); return; }
  if (!selected || switching) return;
  notice(''); startedAt=0; transcriptItems=[]; pendingText.clear(); $('transcript').replaceChildren(); $('timer').textContent='00:00';
  const current = new VoiceCall(selected, {
    audioElement:$('remote-audio'), socketUrl:`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/call`,
    onState: state => { if (call === current) updateState(state); },
    onTranscript: event => { if (call === current) transcript(event); },
    onNotice: message => { if (call === current) notice(message); }
  });
  call=current; current.start();
});
$('mute').addEventListener('click', () => call?.toggleMute());
$('speaker').addEventListener('click', () => { $('remote-audio').play().then(()=>notice('')).catch(()=>notice('Speaker playback is unavailable until the call connects')); });
window.addEventListener('pagehide', () => call?.hangup());
setInterval(() => { if (!startedAt || !call || call.state==='ended') return; const seconds=Math.floor((Date.now()-startedAt)/1000); $('timer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; },1000);
try {
  const response=await fetch('/api/contacts',{cache:'no-store'}); if(!response.ok) throw new Error('Could not load contacts');
  ({contacts}=await response.json()); renderContacts(); if(contacts[0]) select(contacts[0]);
} catch { $('contacts').textContent='Contacts could not be loaded'; notice('The local dialer gateway is unavailable. Check its configuration and restart it.'); }
