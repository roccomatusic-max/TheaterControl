// Front of house: tell the stage manager the state of the house, get their calls, see the countdown.
'use strict';
$('#night').append(nightBtn());
C.defaultName = 'Front of house';
const page = $('#page');
const ORDER = ['not-open', 'open', 'hold', 'closed', 'interval'];
const note = h('input', { placeholder: 'Optional note, e.g. "coach party of 40 still queuing"', style: 'flex:1' });
const btns = h('div', { class: 'fohbtns' });
const status = h('div', {}), count = h('div', {}), showLine = h('div', { class: 'dim', style: 'margin-top:6px' });
const lobby = h('input', { placeholder: 'Message on the lobby screen', style: 'flex:1' });
const calls = h('div', { class: 'items' });

function draw() {
  const f = C.crew.foh;
  fill(btns, ...ORDER.map(s => h('button', { class: f.status === s ? 'cur' : '', onclick: () => ask('foh', { status: s, note: note.value.trim() }).then(r => r.ok && (note.value = '')) }, FOH_TEXT[s])));
  fill(status, h('div', { style: 'font-size:24px;font-weight:800' }, FOH_TEXT[f.status]),
    h('div', { class: 'dim' }, f.at ? `Set by ${f.by} at ${clock(f.at)}${f.note ? `: ${f.note}` : ''}` : 'Not set yet tonight'));
  const sh = C.show, lf = sh.cues[sh.lastFired];
  showLine.textContent = sh.timers.show.start ? `Show running ${fmtDur(timerMs('show'))}${lf ? ` · last cue ${cueNo(lf, sh.lastFired)} ${lf.label}` : ''}` : 'Show not started';
  if (document.activeElement !== lobby) lobby.value = C.crew.lobby || '';
  const mine = C.crew.calls.filter(c => c.to === 'all' || c.to === 'foh').slice(-8).reverse();
  fill(calls, ...mine.map(c => h('div', { class: 'item' }, h('div', {}, h('b', {}, c.text), h('div', { class: 'meta' }, `${clock(c.at)} from ${c.by}`)))));
  if (!mine.length) calls.append(h('p', { class: 'dim' }, 'No calls yet.'));
}
on('init', () => {
  fill(page, h('div', { style: 'max-width:820px;margin:0 auto;display:grid;gap:10px' },
    h('div', { class: 'card' }, h('h3', {}, 'The house is…'), status, showLine),
    btns, h('div', { class: 'row' }, note),
    h('div', { class: 'card' }, h('h3', {}, 'Countdown'), count),
    h('div', { class: 'card' }, h('h3', {}, 'Lobby screen'), h('div', { class: 'row' }, lobby,
      h('button', { onclick: () => ask('lobby', { text: lobby.value }) }, 'Show'), h('button', { onclick: () => { lobby.value = ''; ask('lobby', { text: '' }); } }, 'Clear'))),
    h('div', { class: 'card' }, h('h3', {}, 'Calls from the stage manager'), calls)));
  draw();
});
on('crew', draw); on('show', draw);
on('call', c => { if (c.to === 'all' || c.to === 'foh') callOverlay(c); });
on('tick', () => {
  $('#clock').textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!C.ready) return;
  const cd = C.crew.countdown;
  fill(count, cd ? h('div', {}, h('div', { class: 'dim' }, cd.label), h('div', { style: 'font-size:44px;font-weight:900;font-variant-numeric:tabular-nums' }, cd.target > now() ? fmtCount(cd.target - now()) : cd.done || '0:00'))
    : h('div', { class: 'dim' }, 'No countdown running'));
  if (C.show.timers.show.start) showLine.textContent = showLine.textContent.replace(/^Show running [\d:]+/, `Show running ${fmtDur(timerMs('show'))}`);
});
boot();
