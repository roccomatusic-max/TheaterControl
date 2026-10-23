// ---------- Buttons, MIDI and timecode ----------
'use strict';
S.keysGo = store('keysGo') === '1';
S.webMidi = store('webMidi') === '1';
onMsg('init', m => { S.timecode = m.timecode || null; drawTcChip(); });
onMsg('timecode', m => { S.timecode = m.timecode; drawTcChip(); });
onMsg('remote', m => { S.remote = m.remote; (updaters.__remote || []).forEach(f => f()); });

// ---------- a keyboard, foot pedal or page turner on this screen ----------
const GO_KEYS = [' ', 'Enter', 'PageDown', 'ArrowRight', 'ArrowDown'], BACK_KEYS = ['PageUp', 'ArrowLeft', 'ArrowUp'];
let keyAt = 0;
document.addEventListener('keydown', e => {
  if (!S.keysGo || !S.show || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select') || document.querySelector('.sheet') || document.body.classList.contains('locked')) return;
  const go = GO_KEYS.includes(e.key), back = BACK_KEYS.includes(e.key);
  if (!go && !back) return;
  e.preventDefault();
  if (Date.now() - keyAt < 600) return; // a pedal that bounces, or a double tap
  keyAt = Date.now();
  if (S.tab === 'dept' && S.myDept && S.depts?.split[S.myDept]) { if (go) ask('dept-go', { dept: S.myDept }).then(r => r?.error && toast(r.error, 4000)); return; }
  if (go) send({ t: 'show', action: 'go' });
  else send({ t: 'show', action: 'standby', index: Math.max(0, S.show.index - 1) });
});

// ---------- MIDI devices plugged into this computer (Chrome and Edge) ----------
let midiAccess = null, midiQueue = [], midiTimer = null;
async function startWebMidi() {
  if (!navigator.requestMIDIAccess) { toast('This browser has no MIDI. Use Chrome or Edge on the computer the MIDI device is plugged into.', 7000); return false; }
  try { midiAccess = await navigator.requestMIDIAccess({ sysex: true }); } catch {
    try { midiAccess = await navigator.requestMIDIAccess(); } catch (e) { toast(`MIDI was not allowed: ${e.message}`, 6000); return false; }
  }
  const hook = () => { midiAccess.inputs.forEach(inp => { inp.onmidimessage = e => queueMidi([...e.data]); }); (updaters.__remote || []).forEach(f => f()); };
  hook(); midiAccess.onstatechange = hook;
  return true;
}
function queueMidi(b) {
  const st = b[0];
  // notes, controllers, program changes, MIDI Show Control and timecode (not clock, sensing, bends)
  if (!((st >= 0x80 && st < 0xa0) || (st >= 0xb0 && st < 0xd0) || st === 0xf0 || st === 0xf1)) return;
  midiQueue.push(b);
  if (!midiTimer) midiTimer = setTimeout(() => { midiTimer = null; const messages = midiQueue; midiQueue = []; if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'midi-in', messages })); }, 20);
}
if (S.webMidi) startWebMidi();

// ---------- timecode on the Show tab ----------
const tcChip = h('button', { class: 'tcchip always', onclick: async () => {
  const t = S.timecode;
  if (!confirm(t.follow ? 'Stop firing cues by timecode?' : `Fire the ${t.cues} cue${t.cues === 1 ? '' : 's'} with a timecode by themselves from now on?`)) return;
  const r = await ask('timecode-follow', { on: !t.follow }); if (r.error) toast(r.error, 5000);
} });
function drawTcChip() {
  const t = S.timecode;
  tcChip.hidden = !t || (!t.cues && !t.text);
  if (tcChip.hidden) return;
  tcChip.className = `tcchip always ${t.running ? 'run' : ''} ${t.follow ? 'follow' : ''}`;
  fill(tcChip, h('b', { class: 'mono' }, `TC ${t.text || '--:--:--:--'} ${t.running ? '▶' : '■'}`), h('span', {}, t.follow ? `following · ${t.cues} cues` : 'not following'));
}
STANDBY_EXTRAS.push(() => tcChip);

// ---------- System tab ----------
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const admin = S.role === 'admin';
  const learn = (action, arg) => ask('remote-learn', { action, arg }).then(r => r.error && toast(r.error, 5000));
  const draw = () => {
    const r = S.remote;
    if (!r) return;
    if (r.error) return fill(body, h('div', { class: 'bad' }, r.error));
    const set = patch => ask('remote-set', patch).then(x => { if (x.error) toast(x.error, 5000); else { S.remote = x; draw(); } });
    const urls = r.http && r.key ? r.addresses.map(a => `http://${a}:${r.port}/remote/${r.key}/`) : [];
    const depts = (S.depts?.list || []).filter(d => S.show.cues.some(c => deptActs(c, d.id).length));
    const t = r.timecode;
    fill(body,
      h('div', { class: 'sub' }, 'This screen'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.keysGo, onchange: e => { S.keysGo = e.target.checked; store('keysGo', S.keysGo ? '1' : ''); } }),
        'A keyboard, foot pedal or page turner here runs GO'),
      h('p', { class: 'dim small' }, 'Space, Enter, Page Down or → is GO; Page Up or ← moves standby back one cue. A Bluetooth page-turner pedal works on the iPad. On the second operator screen it is that department\'s GO.'),
      navigator.requestMIDIAccess ? [
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.webMidi, onchange: async e => { const on = e.target.checked && await startWebMidi(); S.webMidi = !!on; store('webMidi', on ? '1' : ''); draw(); } }),
          'Use MIDI devices plugged into this computer'),
        S.webMidi && midiAccess ? h('p', { class: 'dim small' }, midiAccess.inputs.size ? `Listening to: ${[...midiAccess.inputs.values()].map(i => i.name).join(', ')}` : 'No MIDI devices found yet. Plug one in.') : null]
        : h('p', { class: 'dim small' }, 'For a MIDI device plugged into a computer, open Show Control in Chrome or Edge on that computer.'),

      h('div', { class: 'sub' }, 'Stream Deck and other buttons'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.http, disabled: !admin, onchange: e => set({ http: e.target.checked }) }), 'Buttons can run the show through a web address'),
      urls.length ? [
        h('p', { class: 'dim small' }, 'In Bitfocus Companion add a "Generic: HTTP Requests" connection, and give each Stream Deck button a GET request to one of these (use the address on the same network as Companion). Anyone with this address can press GO, so keep it to the show team.'),
        h('div', { class: 'urls mono' }, urls.map(u => h('div', {}, `${u}go`))),
        h('p', { class: 'dim small' }, `Instead of go: back, next, stop (emergency stop), fire/<cue number>, ${depts.map(d => `dept/${d.id}`).join(', ') || 'dept/<department>'} (a second operator's GO), or state (what is on standby, for button labels).`),
        admin && h('button', { class: 'mini', onclick: () => confirm('Make a new address? Buttons using the old one stop working until you change them.') && set({ newKey: true }) }, 'Make a new address')] : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.osc, disabled: !admin, onchange: e => set({ osc: e.target.checked }) }), 'Buttons can run the show with OSC'),
      r.osc ? h('div', { class: 'oscport' }, 'OSC port', h('input', { class: 'time', value: r.oscPort, disabled: !admin, inputmode: 'numeric', onchange: e => set({ oscPort: e.target.value }) })) : null,
      r.osc ? h('p', { class: 'dim small' }, r.oscOn ? `Listening. Send /showcontrol/go (or back, next, stop, fire <cue>, dept/<department>/go, timecode "01:02:03:04") to this computer (${r.addresses.join(' or ')}) from Companion, TouchOSC, a QLab Network cue or an Eos cue.` : 'Not listening: that port is in use. Pick another.') : null,

      h('div', { class: 'sub' }, 'MIDI buttons'),
      r.midi.length ? h('div', { class: 'maps' }, r.midi.map((x, i) => h('div', { class: 'bk' }, h('span', {}, `${x.words} → ${x.does}`), admin && h('button', { class: 'mini', onclick: () => set({ forget: i }) }, 'Forget'))))
        : h('p', { class: 'dim small' }, 'None yet. Tap Learn, then press the button on your MIDI device or keyboard.'),
      r.learning ? h('div', { class: 'learning' }, `Press the MIDI button for "${r.learning}" now…`, h('button', { class: 'mini always', onclick: () => ask('remote-learn', { cancel: true }) }, 'Cancel'))
        : h('div', { class: 'row' }, h('button', { class: 'mini', onclick: () => learn('go') }, 'Learn GO'), h('button', { class: 'mini', onclick: () => learn('back') }, 'Learn Back'),
          h('button', { class: 'mini', onclick: () => learn('stop') }, 'Learn STOP'), depts.map(d => h('button', { class: 'mini', onclick: () => learn('dept', d.id) }, `Learn ${d.name} GO`))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.msc, disabled: !admin, onchange: e => set({ msc: e.target.checked }) }), 'MIDI Show Control GO from a console runs GO (with a cue number, it fires that cue)'),
      r.lastMidi ? h('p', { class: 'dim small' }, `Last MIDI: ${r.lastMidi.words} from ${r.lastMidi.from} at ${hhmm(r.lastMidi.at)}`) : null,

      h('div', { class: 'sub' }, 'Timecode'),
      h('p', {}, t.text ? `${t.text} ${t.running ? '▶ running' : '■ stopped'} · from ${t.source} · ${t.fps} fps` : 'No timecode received yet. Send MIDI timecode (MTC) from QLab or a playback computer through network MIDI or a MIDI device on this computer, or OSC.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.follow, onchange: e => ask('timecode-follow', { on: e.target.checked }).then(x => x.error ? toast(x.error, 5000) : (S.remote.timecode = x)) }),
        `Fire cues at their timecode (${t.cues} cue${t.cues === 1 ? ' has' : 's have'} one; set it in Edit cues)`));
  };
  (updaters.__remote ||= []).push(draw);
  ask('remote-get').then(x => { S.remote = x; draw(); });
  return h('div', { class: 'card hcard' }, h('h3', {}, 'Buttons, MIDI and timecode'), body);
});
