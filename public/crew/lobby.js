// Lobby TV: the show name and a big countdown, readable from across the foyer. No buttons.
'use strict';
const page = $('#page');
const sn = h('div', { class: 'sn' }), cl = h('div', { class: 'cl' }), cd = h('div', { class: 'cd' }), msg = h('div', { class: 'msg' }), tod = h('div', { class: 'tod' });
page.className = 'lobbyview';
page.append(h('div', {}, sn, cl, cd, msg), tod);
on('tick', () => {
  tod.textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!C.ready) return;
  sn.textContent = C.show.name;
  const c = C.crew.countdown, left = c ? c.target - now() : 0;
  cl.textContent = c ? (left > 0 ? c.label : '') : '';
  cd.textContent = c ? (left > 0 ? fmtCount(left) : (c.done || '')) : '';
  cd.style.fontSize = c && left <= 0 ? '7vw' : '';
  msg.textContent = C.crew.lobby || '';
});
// A TV has no one to tap it: ask for full screen on the first click, if there is one.
document.addEventListener('click', () => document.documentElement.requestFullscreen?.().catch(() => {}), { once: true });
boot();
