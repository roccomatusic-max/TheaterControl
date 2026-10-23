// ---------- Health: equipment status, alerts, pre-show check, phone alerts ----------
'use strict';
const STATUS_WORDS = { online: 'Answering', connecting: 'Connecting…', offline: 'Not answering', sim: 'Pretend' };
const CHECK_ICON = { ok: '✓', warn: '!', error: '✕', info: 'i' };
const since = ms => { const m = Math.floor(ms / 60000); return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const openHealth = () => { S.tab = 'health'; render(); };
VIEWS.health = () => healthTab();
NAV_PARENT.health = 'sys';
$('#statusDots').addEventListener('click', openHealth);

// ---------- the alert bar on every screen ----------
// Equipment that stopped answering, the emergency stop, possible feedback, low mic batteries. Each
// stays until it's dismissed (for everyone) or, for equipment, until it answers again.
const seenAlerts = new Set();
function renderAlerts() {
  // the emergency stop has its own banner, so it isn't repeated here
  const bar = $('#alertBar'), list = (S.alerts || []).filter(a => a.kind !== 'emergency');
  const fresh = list.filter(a => !seenAlerts.has(`${a.key}@${a.at}`));
  if (fresh.length) { navigator.vibrate?.([200, 100, 200]); beep(); }
  list.forEach(a => seenAlerts.add(`${a.key}@${a.at}`));
  bar.hidden = !list.length;
  const dismiss = a => send({ t: 'alert-dismiss', key: a.key });
  // Several pieces of equipment at once (a switch or a cable): one line, not a wall of alerts.
  const down = list.filter(a => a.kind === 'equipment');
  const rows = down.length > 1 ? [{ group: down, at: Math.min(...down.map(a => a.at)) }, ...list.filter(a => a.kind !== 'equipment')] : list;
  bar.replaceChildren(...rows.slice(0, 3).map(r => r.group
    ? h('div', { class: 'alert equipment' }, h('b', { onclick: openHealth }, `${r.group.length} stopped answering: ${r.group.slice(0, 5).map(a => a.name || a.key).join(', ')}${r.group.length > 5 ? ` and ${r.group.length - 5} more` : ''}`),
      h('span', {}, `since ${clock(r.at)}${r.group.length >= 3 ? ' · check the show network switch' : ''}`),
      h('button', { class: 'always', onclick: openHealth }, 'Details'), h('button', { class: 'always', onclick: () => r.group.forEach(dismiss) }, 'Dismiss'))
    : h('div', { class: `alert ${r.kind || ''}` }, h('b', {}, r.title), h('span', {}, `${r.detail ? `${r.detail} · ` : ''}${clock(r.at)}`),
      r.action && h('button', { class: 'danger always', onclick: () => { cmd(r.action.device, r.action.cmd, r.action.args); dismiss(r); } }, r.action.label),
      r.kind === 'equipment' && h('button', { class: 'always', onclick: openHealth }, 'Details'),
      h('button', { class: 'always', onclick: () => dismiss(r) }, 'Dismiss'))),
  ...(rows.length > 3 ? [h('div', { class: 'dim' }, `and ${rows.length - 3} more`)] : []));
}
// A short beep for alerts. Browsers only allow sound after the screen has been touched once.
let audio;
document.addEventListener('pointerdown', () => { try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no sound */ } }, { once: true });
function beep() {
  if (!audio || audio.state !== 'running') return;
  [0, 0.25].forEach(at => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g).connect(audio.destination); o.start(audio.currentTime + at); o.stop(audio.currentTime + at + 0.15);
  });
}
onMsg('init', m => { S.lastCheck = m.lastCheck || null; });
onMsg('alerts', () => { if (S.tab === 'health') S.healthRefresh?.(); });
onMsg('notice', m => { toast(m.msg, 5000); if (S.tab === 'health') S.healthRefresh?.(); });
onMsg('check', m => { S.lastCheck = m.check; if (S.tab === 'health') S.drawCheck?.(); });

// ---------- System tab card ----------
SYS_CARDS.push(() => {
  const sum = h('div', { class: 'kv' });
  const upd = () => {
    const ds = Object.values(S.devices), up = ds.filter(d => d.status === 'online').length;
    const c = S.lastCheck;
    sum.replaceChildren(h('b', {}, 'Equipment'), h('span', { class: up === ds.length ? 'good' : 'bad' }, `${up} of ${ds.length} answering`),
      h('b', {}, 'Pre-show check'), h('span', {}, c ? `${clock(c.at)}: ${checkSummary(c)}` : 'not run yet'));
  };
  (updaters.__anyDevice ||= []).push(upd); upd();
  return h('div', { class: 'card hcard' }, h('h3', {}, 'Health'), sum,
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'primary', onclick: () => { S.runCheck = true; openHealth(); } }, 'Pre-show check'),
      h('button', { onclick: openHealth }, 'Equipment health')));
});
const checkSummary = c => c.errors ? `${c.errors} problem${c.errors > 1 ? 's' : ''}${c.warnings ? `, ${c.warnings} to look at` : ''}` : c.warnings ? `${c.warnings} to look at` : 'all clear';

// ---------- Health screen ----------
function healthTab() {
  const checkBox = h('div');
  const tiles = h('div', { class: 'tiles' });
  const alerts = h('div', { class: 'alerts' });
  const phone = h('div');
  let info = { devices: {}, alerts: [] }, offset = 0, running = false;

  const runCheck = async () => {
    running = true; drawCheck();
    const r = await ask('preshow-check', {}, 30000);
    running = false;
    if (r.error) toast(r.error, 5000); else S.lastCheck = r;
    drawCheck();
  };
  const fix = async item => {
    for (const m of item.fix.msgs) send(m);
    setTimeout(runCheck, 1500);
  };
  function drawCheck() {
    const c = S.lastCheck;
    const head = h('div', { class: 'checkhead' },
      h('button', { class: 'primary big', disabled: running, onclick: runCheck }, running ? 'Checking…' : c ? 'Check again' : 'Run pre-show check'),
      c ? h('div', { class: `verdict ${c.errors ? 'bad' : c.warnings ? 'warn' : 'good'}` }, h('b', {}, c.errors ? 'Not ready' : c.warnings ? 'Ready, with things to look at' : 'Ready'),
        h('span', {}, `${checkSummary(c)} · checked at ${clock(c.at)}${c.by ? ` from ${c.by}` : ''}`))
        : h('div', { class: 'dim' }, 'Tests every piece of equipment, the cue list and this computer. Run it before the house opens.'));
    const groups = c ? [...new Set(c.items.map(i => i.group))] : [];
    checkBox.replaceChildren(head, ...groups.map(g => h('div', { class: 'checkgroup' }, h('div', { class: 'sub' }, g),
      c.items.filter(i => i.group === g).sort((a, b) => ['error', 'warn', 'ok', 'info'].indexOf(a.state) - ['error', 'warn', 'ok', 'info'].indexOf(b.state))
        .map(i => h('div', { class: `checkitem ${i.state}` }, h('span', { class: 'ic' }, CHECK_ICON[i.state]),
          h('div', {}, h('b', {}, i.label), h('div', { class: 'detail' }, i.detail)),
          i.fix ? h('button', { onclick: () => fix(i) }, i.fix.label) : '')))));
  }
  function drawTiles() {
    const now = Date.now() + offset;
    tiles.replaceChildren(...Object.values(S.devices).map(d => {
      const t = info.devices[d.id];
      return h('div', { class: `tile ${d.status}` }, h('div', { class: 'nm' }, h('i'), d.name.split(' · ')[0]),
        h('div', { class: 'st' }, STATUS_WORDS[d.status] || d.status, t ? ` for ${since(now - t.since)}` : ''),
        h('div', { class: 'dim' }, d.status === 'online' && d.lastSeen ? `last answer ${Math.max(0, Math.round((now - d.lastSeen) / 1000))} s ago` : d.type === 'osc' ? 'sends only' : ''),
        t?.drops ? h('div', { class: 'drops' }, `dropped out ${t.drops}× in the last 12 h`) : '');
    }));
  }
  function drawAlerts() {
    alerts.replaceChildren(...info.alerts.length ? info.alerts.map(a => h('div', { class: `al ${a.level}` }, h('span', { class: 'mono' }, clock(a.at)), ' ', a.msg))
      : [h('div', { class: 'dim' }, 'No alerts since Show Control started.')]);
  }
  function drawPhone(p) {
    if (p.error) return phone.replaceChildren(h('div', { class: 'bad' }, p.error));
    if (!p.on) return phone.replaceChildren(
      h('p', {}, 'Get a notification on your phone when equipment stops answering or someone presses STOP, even when this app is closed.'),
      h('p', { class: 'dim' }, 'Uses the free ntfy app. This computer needs internet for it (the control network).'),
      h('button', { class: 'primary', onclick: async () => drawPhone(await ask('alerts-phone', { on: true })) }, 'Turn on phone alerts'));
    const result = h('div', { class: 'last' });
    phone.replaceChildren(
      h('ol', { class: 'steps' },
        h('li', {}, 'Install the free ', h('b', {}, 'ntfy'), ' app on your phone (App Store or Google Play).'),
        h('li', {}, 'In ntfy tap ', h('b', {}, '+'), ' and subscribe to this name:', h('div', { class: 'mono topic' }, p.topic),
          p.server !== 'https://ntfy.sh' ? h('div', { class: 'dim' }, `Use another server: ${p.server}`) : ''),
        h('li', {}, 'Or scan this code with the phone camera:', h('div', { class: 'qr' }))),
      h('p', { class: 'dim' }, 'Anyone who knows this name can read the alerts, so only share it with your crew.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { result.textContent = 'Sending…'; const r = await ask('alerts-test'); result.textContent = r.detail || r.error; result.className = `last ${r.ok ? '' : 'bad'}`; } }, 'Send a test alert'),
        h('button', { onclick: async () => drawPhone(await ask('alerts-phone', { on: false })) }, 'Turn off')),
      result);
    phone.querySelector('.qr').innerHTML = p.qr; // SVG made by Show Control itself
  }
  const refresh = async () => {
    const r = await ask('health-get');
    if (r.error) return;
    info = r; offset = r.now - Date.now();
    drawTiles(); drawAlerts(); drawPhone(r.phone || { on: false });
  };
  S.healthRefresh = refresh; S.drawCheck = drawCheck;
  let n = 0;
  (updaters.__tick ||= []).push(() => { if (++n % 4 === 0) drawTiles(); if (n % 40 === 0) refresh(); });
  (updaters.__anyDevice ||= []).push(drawTiles);
  drawCheck(); drawTiles(); refresh();
  if (S.runCheck) { S.runCheck = false; runCheck(); }

  return h('div', { class: 'grid healthview' },
    h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Pre-show check', h('button', { onclick: () => { S.tab = 'sys'; render(); } }, '← System')), checkBox),
    h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Equipment right now'), tiles),
    h('div', { class: 'card' }, h('h3', {}, 'Recent alerts'), alerts),
    h('div', { class: 'card' }, h('h3', {}, 'Alerts on your phone'), phone));
}
