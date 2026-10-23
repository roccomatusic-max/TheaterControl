// ---------- Backup computer and spare screens ----------
'use strict';
const at = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- moving to the backup computer ----------
// This page came from one computer; if that one stops, keep trying it, then the other one.
let hostIdx = 0, attempts = 0;
const hosts = () => [location.host, ...(S.failover?.peer && S.failover.peer !== location.host ? [S.failover.peer] : [])];
wsHost = () => {
  const hs = hosts();
  if (attempts++ >= 2 && hs.length > 1) { attempts = 1; hostIdx = (hostIdx + 1) % hs.length; }
  return hs[hostIdx % hs.length];
};
const fbBar = h('div', { id: 'failoverBar', hidden: true });
$('#emergencyBar').before(fbBar);
onMsg('init', m => {
  attempts = 0;
  S.failover = m.failover || null;
  const f = S.failover;
  // Arrived at the standby computer while looking for the one running the show: keep looking.
  if (f && !f.active && hostIdx !== 0) { setTimeout(() => ws.close(), 0); return; }
  drawFailover();
  const off = $('#offline span');
  if (off) off.textContent = f?.peer ? `Reconnecting… If the show computer has stopped, this screen moves to the backup computer (${f.peer}) by itself.` : 'Reconnecting… Buttons do nothing until this goes away.';
});
onMsg('failover', () => ws.close()); // this computer changed role: reconnect for a fresh start
function drawFailover() {
  const f = S.failover;
  fbBar.hidden = !f || (f.active && f.role === 'main');
  if (fbBar.hidden) return;
  const other = `http://${f.peer}/`;
  fbBar.className = f.active ? 'running' : 'standby';
  fbBar.replaceChildren(...f.active
    ? [h('span', {}, `The backup computer is running the show (since ${at(f.since)}${f.reason ? `: ${f.reason}` : ''}).`)]
    : [h('span', {}, `This is the ${f.role === 'main' ? 'main' : 'backup'} computer, on standby. The show is running on ${f.peer}.`), h('a', { href: other }, 'Open that one')]);
}

// ---------- System tab: backup computer ----------
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const msg = h('div', { class: 'last' });
  const draw = f => {
    if (f.error) return body.replaceChildren(h('div', { class: 'bad' }, f.error));
    const admin = S.role === 'admin';
    const st = { role: f.role || 'main', peer: f.peer || '' };
    const form = admin && h('div', { class: 'form' },
      h('label', {}, 'This computer is the', h('select', { onchange: e => (st.role = e.target.value) },
        h('option', { value: 'main', selected: st.role === 'main' }, 'Main computer'), h('option', { value: 'backup', selected: st.role === 'backup' }, 'Backup computer'))),
      h('label', {}, 'Address of the other computer', h('input', { value: st.peer, placeholder: 'e.g. 10.101.50.6', oninput: e => (st.peer = e.target.value.trim()) })),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { const r = await ask('failover-set', st); msg.textContent = r.error || (r.restarting ? 'Saved. Show Control is restarting…' : 'Saved. Restart Show Control for it to take effect.'); } }, f.role ? 'Save' : 'Turn on'),
        f.role && h('button', { onclick: async () => { if (!confirm('Turn off the backup computer arrangement on this computer?')) return; const r = await ask('failover-set', { role: null }); msg.textContent = r.error || 'Turned off.'; } }, 'Turn off')));
    if (!f.role) return fill(body,
      h('p', {}, 'A second computer running Show Control can keep a copy of the show and take over by itself if this one stops. The iPads move across automatically.'),
      f.mode === 'practice' ? h('p', { class: 'dim' }, 'Set this up once you are live with the real equipment.') : [
        h('ol', { class: 'steps' }, h('li', {}, 'Install Show Control on the second computer, plug it into both networks like this one, and go live on it with the same admin PIN.'),
          h('li', {}, 'Here, choose "Main computer" and type the second computer\'s address.'), h('li', {}, 'On the second computer, choose "Backup computer" and type this computer\'s address.')),
        form || h('p', { class: 'dim' }, 'Only the admin PIN can set this up.')], msg);
    const status = f.role === 'main' && f.active ? (f.mirror ? ['good', `Backup computer (${f.peer}) connected and keeping a copy of the show.`] : ['bad', `Backup computer (${f.peer}) not connected, so it can't take over.`])
      : f.active ? ['bad', `This backup computer is running the show (since ${at(f.since)}${f.reason ? `: ${f.reason}` : ''}).`]
        : [f.linked ? 'good' : 'bad', f.linked ? `On standby, copying the show from ${f.peer}${f.lastCopy ? ` (last copy ${at(f.lastCopy)})` : ''}. It takes over by itself if that computer stops answering.` : `On standby, but can't reach ${f.peer}. It will take over if that doesn't come back.`];
    fill(body, h('p', { class: status[0] }, status[1]),
      admin && h('div', { class: 'row' },
        !f.active && h('button', { class: 'danger', onclick: async () => { if (!confirm('Take over the show on this computer now? Only do this if the other computer has really stopped.')) return; const r = await ask('failover-takeover'); msg.textContent = r.error || 'This computer is running the show now.'; } }, 'Take over now'),
        f.active && f.role === 'backup' && h('button', { onclick: async () => { if (!confirm(`Hand the show back to the main computer (${f.peer})? This computer restarts on standby.`)) return; const r = await ask('failover-handback'); msg.textContent = r.error || 'Handed back. This screen moves to the main computer.'; } }, 'Hand back to the main computer')),
      admin && h('details', {}, h('summary', {}, 'Change the arrangement'), form), msg);
  };
  ask('failover-get').then(draw);
  return h('div', { class: 'card' }, h('h3', {}, 'Backup computer'), body);
});

// ---------- spare screens ----------
const guessName = () => { const u = navigator.userAgent; const k = /iPad|Macintosh.*Mobile/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : 'Screen'; return `${k} ${Math.random().toString(36).slice(2, 4).toUpperCase()}`; };
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* private mode */ } return v; };
const screenId = store('screenId') || store('screenId', `s${Math.random().toString(36).slice(2, 12)}`);
const isNew = !store('screenName');
let screenName = store('screenName') || store('screenName', guessName());
const view = () => ({ tab: S.tab, camSel: S.camSel || null, projGroup: S.projGroup || null, dept: S.myDept || null, screenLocked: document.body.classList.contains('locked') });
let lastView = '';
const hello = () => { lastView = JSON.stringify(view()); send({ t: 'screen-hello', screen: screenId, name: screenName, view: view() }); };
setInterval(() => { if (ws?.readyState === 1 && S.show && JSON.stringify(view()) !== lastView) hello(); }, 2000);
let offered = false;
onMsg('init', m => {
  S.screens = m.screens || [];
  setTimeout(hello, 0);
  // A brand-new screen (e.g. the spare iPad) offers to carry on from one that dropped off recently.
  const gone = S.screens.filter(s => !s.connected && s.id !== screenId && Date.now() + S.clockSkew - s.lastSeen < 60 * 60e3);
  if (isNew && !offered && gone.length && !(S.failover && !S.failover.active)) { offered = true; setTimeout(() => offerTakeover(gone), 300); }
});
onMsg('screens', m => { S.screens = m.screens; (updaters.__screens || []).forEach(f => f()); });
const TAB_WORDS = { show: 'Show', lx: 'Lighting', snd: 'Sound', proj: 'Projection', cam: 'Cameras', sys: 'System', edit: 'Edit cues', setup: 'Setup', health: 'Health', history: 'Cue list history', map: 'Scene map', dept: 'Second operator' };
async function carryOn(s, force) {
  const r = await ask('screen-takeover', { from: s.id, force });
  if (r.error) { if (/still connected/.test(r.error) && confirm(r.error)) return carryOn(s, true); return toast(r.error, 5000); }
  screenName = store('screenName', r.name);
  const v = r.view || {};
  if (v.camSel) S.camSel = v.camSel;
  if (v.projGroup) S.projGroup = v.projGroup;
  if (v.dept) S.myDept = store('myDept', v.dept); // a second operator's spare carries on with the same department
  setLock(!!v.screenLocked); renderLock();
  S.tab = v.tab && v.tab !== 'setup' ? v.tab : 'show'; store('tab', S.tab);
  render(); hello();
  toast(`Carrying on from ${r.name}`);
}
function offerTakeover(gone) {
  let el;
  el = sheet(h('h2', {}, 'Replacing another screen?'),
    h('p', {}, 'If this iPad or phone is standing in for one that stopped, it can carry on with the same name and the same screen.'),
    gone.slice(0, 4).map(s => h('button', { class: 'choice always', onclick: () => { el.remove(); carryOn(s); } },
      h('b', {}, `Carry on from ${s.name}`), h('span', {}, `Was showing ${TAB_WORDS[s.view?.tab] || 'the app'} · dropped off at ${at(s.lastSeen)}`))));
}
SYS_CARDS.push(() => {
  const list = h('div', { class: 'screens' });
  const draw = () => list.replaceChildren(...(S.screens || []).map(s => h('div', { class: `scr ${s.connected ? 'on' : 'off'}` },
    h('div', {}, h('b', {}, s.name), s.id === screenId ? h('span', { class: 'pill' }, 'this screen') : '',
      h('div', { class: 'dim' }, `${s.role === 'viewer' ? 'Watch only' : s.role === 'operator' ? 'Operator' : 'Admin'} · ${TAB_WORDS[s.view?.tab] || '—'} · ${s.connected ? `connected (${s.who})` : `dropped off at ${at(s.lastSeen)}`}`)),
    s.id === screenId ? h('button', { class: 'mini always', onclick: () => { const n = prompt('Name for this screen (e.g. "Rocco\'s iPad", "SM desk")', screenName); if (n?.trim()) { screenName = store('screenName', n.trim().slice(0, 40)); hello(); } } }, 'Rename')
      : h('button', { class: 'mini always', onclick: () => carryOn(s) }, 'Carry on here'))));
  (updaters.__screens ||= []).push(draw); draw();
  return h('div', { class: 'card' }, h('h3', {}, 'Screens'),
    h('p', { class: 'dim' }, 'Every iPad, phone and computer using Show Control. If one stops, open Show Control on a spare and tap "Carry on here" next to it.'), list);
});
