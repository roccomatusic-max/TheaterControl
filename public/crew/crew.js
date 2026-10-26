// Crew phone: pick your role once, then see your cue light, your own run sheet and calls.
'use strict';
$('#night').append(nightBtn());
const page = $('#page');
let picking = !me().role, showAll = false, showChecks = false;
let goUntil = 0, goCue = null, lastLightKey = '', lastStandby = '';

function picker() {
  const name = h('input', { placeholder: 'Your name', value: me().name, style: 'width:100%' });
  const choose = role => { if (!name.value.trim()) { toast('Type your name first'); return name.focus(); } setMe('name', name.value.trim()); setMe('role', role); picking = false; draw(); };
  fill(page, h('div', { class: 'card form', style: 'max-width:640px;margin:0 auto' },
    h('h3', {}, 'Who are you tonight?'), h('label', {}, 'Name', name),
    h('div', { class: 'big-label' }, 'Your job (you get its cues and calls)'),
    h('div', { class: 'roles' }, C.crew.roles.map(r => h('button', { class: r === me().role ? 'on' : '', onclick: () => choose(r) }, r)),
      h('button', { onclick: () => choose('-') }, 'Calls only')),
    h('p', { class: 'hint' }, 'Tip: in Safari tap Share → Add to Home Screen, and turn the phone\'s silent switch off to hear calls.')));
}

function light() {
  const role = me().role, sh = C.show, i = sh.index, c = sh.cues[i];
  if (goUntil > Date.now()) return { state: 'go', key: `go${goCue}`, cue: sh.cues[goCue], i: goCue, tasks: tasksFor(sh.cues[goCue], role) };
  const tasks = tasksFor(c, role), l = C.crew.lights[role];
  if (tasks.length) return { state: 'standby', key: `s${i}${C.crew.acks[role] ? 'a' : ''}`, cue: c, i, tasks, acked: !!C.crew.acks[role] };
  if (l?.state === 'standby') return { state: 'standby', key: `m${l.at}${l.acked ? 'a' : ''}`, manual: true, acked: !!l.acked };
  return { state: 'clear', key: `c${i}` };
}
const lightEl = h('div', { class: 'light' });
function drawLight() {
  const L = light(), role = me().role;
  if (L.key === lastLightKey) return;
  lastLightKey = L.key;
  if (L.state === 'standby' && !L.acked && L.key !== lastStandby) { lastStandby = L.key; beep('standby'); }
  lightEl.className = `light ${L.state} ${L.acked ? 'acked' : ''}`;
  const what = L.cue ? `${cueNo(L.cue, L.i)} ${L.cue.label}` : '';
  fill(lightEl,
    h('small', {}, L.state === 'go' ? 'NOW' : L.state === 'standby' ? 'STANDBY' : 'NOTHING FOR YOU RIGHT NOW'),
    L.state !== 'clear' && h('div', { class: 'big' }, L.state === 'go' ? 'GO' : L.manual ? 'Standby' : `Cue ${cueNo(L.cue, L.i)}`),
    L.tasks?.length > 0 && h('div', { class: 'task' }, L.tasks.map(x => x.task || what).join(' · ')),
    L.cue && L.state === 'standby' && h('div', { class: 'dim', style: 'color:inherit;opacity:.8' }, what),
    L.cue?.note && L.state === 'standby' && h('div', { class: 'cue-note' }, L.cue.note),
    L.state === 'standby' && (L.acked ? h('div', { style: 'margin-top:12px;font-weight:700' }, '✓ Standing by')
      : h('button', { class: 'big primary', onclick: () => ask('standby-ack', { role }) }, 'Standing by')),
    L.state === 'clear' && nextFor(role));
}
function nextFor(role) {
  const sh = C.show, j = sh.cues.findIndex((c, k) => k >= sh.index && tasksFor(c, role).length);
  if (j < 0) return h('div', { class: 'dim', style: 'margin-top:8px' }, 'No more cues for you in this show.');
  const away = j - sh.index;
  return h('div', { style: 'margin-top:8px' }, `Next: cue ${cueNo(sh.cues[j], j)} ${sh.cues[j].label}`, h('div', { class: 'dim' }, `${away} cue${away === 1 ? '' : 's'} away`));
}

const sheet = h('div', { class: 'items sheet' });
function drawSheet() {
  const role = me().role, sh = C.show;
  const rows = sh.cues.map((c, i) => ({ c, i, t: tasksFor(c, role) })).filter(r => showAll || r.t.length);
  fill(sheet, ...rows.map(({ c, i, t }) => h('div', { class: `item ${i < sh.index ? 'done' : ''} ${i === sh.index ? 'next' : ''}` },
    h('div', {}, h('b', {}, `${cueNo(c, i)}  ${c.label}`), t.length > 0 && h('div', {}, t.map(x => x.task).join(' · ')),
      c.note && h('div', { class: 'meta' }, c.note)))));
  if (!rows.length) sheet.append(h('p', { class: 'dim' }, role === '-' ? 'Calls only: no run sheet.' : `No cues for ${role} yet. The stage manager adds crew tasks to cues.`));
}

const checks = h('div', { class: 'items' });
function drawChecks() {
  if (!showChecks) return fill(checks);
  const ck = C.crew.checks;
  fill(checks, ...C.crew.checklist.map((t, i) => h('div', { class: `tick ${ck.ticks[i] ? 'on' : ''}` },
    h('button', { onclick: () => ask('check', { i, on: !ck.ticks[i] }) }, ck.ticks[i] ? '✓' : ''),
    h('div', {}, h('div', { class: 'tx' }, t), ck.ticks[i] && h('div', { class: 'dim', style: 'font-size:12px' }, `${ck.ticks[i].by} · ${clock(ck.ticks[i].at)}`)))));
}
const lastCall = h('div');
function drawLastCall() {
  const role = me().role, c = C.crew.calls.filter(x => ['all', 'crew', role].includes(x.to)).at(-1);
  fill(lastCall, c && Date.now() - c.at < 30 * 60e3 ? h('div', { class: 'card', style: 'margin-bottom:10px' }, h('div', { class: 'dim' }, `Last call ${clock(c.at)}`), h('b', { style: 'font-size:20px' }, c.text)) : '');
}

function draw() {
  if (!C.ready) return;
  if (picking || (me().role !== '-' && !C.crew.roles.includes(me().role))) return picker();
  $('#who').textContent = me().role === '-' || me().role === me().name ? me().name : `${me().role} · ${me().name}`;
  lastLightKey = '';
  const role = me().role;
  fill(page, h('div', { style: 'max-width:720px;margin:0 auto;display:grid;gap:10px' },
    role !== '-' && lightEl, lastCall,
    role !== '-' && h('div', { class: 'card' }, h('h3', {}, showAll ? 'All cues' : 'My cues', h('button', { onclick: () => { showAll = !showAll; drawSheet(); draw(); } }, showAll ? 'Only mine' : 'Show all')), sheet),
    h('div', { class: 'card' }, h('h3', {}, 'Show night checklist', h('button', { onclick: () => { showChecks = !showChecks; drawChecks(); } }, showChecks ? 'Hide' : 'Open')), checks),
    h('button', { class: 'leave', onclick: () => { picking = true; draw(); } }, 'Change name or job')));
  drawLight(); drawSheet(); drawChecks(); drawLastCall();
}

on('init', draw);
on('show', () => { if (picking) return; drawLight(); drawSheet(); });
on('crew', () => { if (picking) return; drawLight(); drawChecks(); drawLastCall(); });
on('go', m => {
  if (!(m.roles || []).includes(me().role)) return;
  goUntil = Date.now() + 4000; goCue = m.index ?? null; beep('go'); drawLight();
});
on('call', c => { if (['all', 'crew', me().role].includes(c.to)) callOverlay(c); });
on('tick', () => { $('#clock').textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); if (C.ready && !picking) drawLight(); });
boot();
