// ---------- Setup: switch from practice (pretend gear) to the real equipment ----------
'use strict';
// Each kind of equipment: what to ask for, and how to turn on network control on the device itself.
// Field: [key, type, label, placeholder]; types: text, password, port, select:value=Label|value=Label
const KINDS = {
  eos: {
    label: 'ETC Eos lighting console', idBase: 'eos', fields: [],
    help: [
      'Plug the console\'s network port into the show network switch.',
      'Exit Eos to the Shell (the start-up screen), then open Settings > Network. Give that port a fixed address (10.101.100.101 is the Eos factory address, mask 255.255.0.0), and tick "UDP Strings & OSC" under Interface Protocols.',
      'Start Eos again. Go to Setup > System > Show Control > OSC and turn on OSC RX and OSC TX.',
      'Type the console\'s address in the Address box and tap Test.',
    ],
  },
  'yamaha-tf': {
    label: 'Yamaha TF mixer', idBase: 'mixer', fields: [],
    help: [
      'Plug the NETWORK port on the back of the TF5 into the show network switch.',
      'On the TF5 screen open Setup, then Network. Choose a fixed (static) address, for example 10.101.50.20, with subnet mask 255.255.0.0.',
      'Type the same address in the Address box and tap Test. (TF Editor and StageMix use the same setting, so if those work, this will too.)',
    ],
  },
  qlab: {
    label: 'QLab', idBase: 'qlab', fields: [['passcode', 'password', 'QLab passcode (only if you set one)', '']],
    help: [
      'On the QLab Mac, give its network connection a fixed address in System Settings > Network (for example 10.101.50.10, mask 255.255.0.0). If QLab runs on this same computer, use 127.0.0.1.',
      'Open your show in QLab. Click the gear icon (Workspace Settings), then Network (QLab 5) or OSC Controls (QLab 4), and make sure OSC access is allowed.',
      'If you set an OSC passcode there, it needs Control permission. Type it in the passcode box.',
      'If the Mac asks whether QLab may accept incoming connections, click Allow. Then tap Test.',
    ],
  },
  ptz: {
    label: 'PTZ camera', idBase: 'cam',
    fields: [['protocol', 'select:visca-ip=VISCA over IP (Sony, BirdDog and most others)|visca-tcp=VISCA over TCP (PTZOptics, Lumens)', 'Control method'],
      ['port', 'port', 'Port (leave empty for the usual one)', '52381 or 5678'], ['video', 'video', 'Video address', 'rtsp://… (tap Find video)']],
    help: [
      'Plug the camera into the show network switch (PoE cameras get their power from it too).',
      'Find the camera\'s address (its manual, its on-screen menu, or the maker\'s finder app) and type it into a web browser to open its settings page.',
      'In its network settings, choose a fixed (static) address, and make sure VISCA over IP is turned on. Note the port number it shows.',
      'Make sure RTSP (video streaming) is turned on too; on most cameras it is on already.',
      'Type the address in the Address box, pick the control method that matches, and tap Test. Then tap Find video to fill in the video address.',
    ],
  },
  camera: {
    label: 'Fixed or infrared camera (video only)', idBase: 'view',
    fields: [['video', 'video', 'Video address', 'rtsp://… (tap Find video)']],
    help: [
      'For a backstage, wings or fly-floor camera that does not move: any IP camera with RTSP video (Hikvision, Dahua, Axis, Reolink, Tapo and most others). An infrared one sees in the dark.',
      'Plug it into the show network switch and give it a fixed address in its settings page or app. Turn on RTSP if it has a switch for it.',
      'Type the address in the Address box and tap Find video. If it asks, type the camera\'s own username and password.',
      'On the Cameras tab, the 🔆 button brightens the picture for dark areas.',
    ],
  },
  panasonic: {
    label: 'Panasonic projector', idBase: 'proj',
    fields: [['model', 'select:pt-dz13k=PT-DZ13K series|pt-dz770=PT-DZ770 series', 'Model'], ['username', 'text', 'Username', 'admin1'], ['password', 'password', 'Password', '']],
    help: [
      'Plug the projector\'s LAN port into the show network switch.',
      'In the projector\'s on-screen menu: NETWORK > NETWORK SETUP. Turn DHCP off and set a fixed address, for example 10.101.60.31, mask 255.255.0.0.',
      'NETWORK > NETWORK CONTROL: turn COMMAND CONTROL on.',
      'Set STANDBY MODE to NORMAL (not ECO), so the projector still answers when it is switched off.',
      'The username and password are the ones for the projector\'s web page (often admin1 / panasonic from the factory). Type them in the boxes and tap Test.',
    ],
  },
  shure: {
    label: 'Shure wireless mic receiver (ULX-D, QLX-D, SLX-D, Axient Digital)', idBase: 'rx',
    fields: [['channels', 'select:4=4 channels (quad)|2=2 channels (dual)|1=1 channel', 'Channels']],
    help: [
      'Plug the receiver\'s network port into the show network switch.',
      'On the receiver\'s front panel open Menu > Network (Advanced Settings on some models). Set IP Mode to Manual and give it a fixed address, for example 10.101.50.31, mask 255.255.0.0. Each receiver needs its own address.',
      'Nothing else to turn on: Show Control uses the same connection as Shure Wireless Workbench. Type the address in the Address box and tap Test.',
      'Then open Mics > Edit packs & scenes and pick this receiver and its channel for each pack, to see battery and signal.',
    ],
  },
  pjlink: {
    label: 'Projector, any brand (PJLink)', idBase: 'proj', fields: [['password', 'password', 'PJLink password (only if it has one)', '']],
    help: [
      'Works with most projectors and screens from Epson, NEC, Sony, Optoma, Christie, Barco and others.',
      'Plug the projector\'s LAN port into the show network switch.',
      'In its menu, set a fixed network address and turn on PJLink (often under Network > Control).',
      'Set its standby mode so the network stays on when it is off (Epson: "Communication On"; others: "Network standby").',
      'Type the address in the Address box and tap Test.',
    ],
  },
};
// Everything the screen knows about one piece of equipment: the brand picked from the list (server),
// what its driver says about itself (server), and the built-in help above.
function kindFor(st, d) {
  const p = (st.profiles || []).find(x => x.id === d.profile);
  const t = st.types?.[d.type], base = KINDS[d.type];
  const help = p?.help || (p?.helpBefore && base ? [...p.helpBefore, ...base.help] : null) || t?.help || base?.help || [];
  return { label: p?.label || base?.label || t?.label || d.type, fields: p?.fields || t?.fields || base?.fields || [], help,
    idBase: base?.idBase || ID_BASE[p?.category || t?.category] || 'dev', addressOptional: t?.addressOptional || null, note: p?.note };
}
const ID_BASE = { lighting: 'lx', sound: 'mixer', playback: 'play', cameras: 'cam', projection: 'proj', effects: 'fx', other: 'dev' };
const kindLabel = t => KINDS[t]?.label || S.setup?.types?.[t]?.label || t;

// The camera's video address, with "Find video": tries the usual addresses for common makes
// of camera and fills in the one that works. Asks for the camera's login if the video needs one.
function videoField(d, label, ph, edited, redraw) {
  const st = (S.setup.videoFind ||= {})[d.id] ||= {};
  const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: d.video || '', placeholder: ph,
    onchange: e => { const v = e.target.value.trim(); if (v) d.video = v; else delete d.video; st.result = null; edited(); } });
  const find = async () => {
    if (!d.host && !d.video) return toast('Type the camera\'s address first', 4000);
    st.running = true; st.result = null; redraw();
    const r = d.video && !st.login ? await ask('find-video', { url: d.video }) : await ask('find-video', { host: d.host, user: st.user || d.username || '', pass: st.pass || d.password || '' }, 120000);
    st.running = false;
    st.result = r.error ? { ok: false, detail: r.error } : r;
    if (r.ok && r.url) { d.video = r.url; edited(); }
    if (r.needsPassword) st.login = true;
    redraw();
  };
  const r = st.result;
  return h('label', { class: 'videofield' }, label,
    h('div', { class: 'row' }, input, h('button', { class: 'always', style: 'flex:0 0 auto', disabled: st.running, onclick: e => { e.preventDefault(); find(); } }, st.running ? 'Looking…' : d.video ? 'Check' : 'Find video')),
    st.login && h('div', { class: 'row' },
      h('input', { placeholder: 'Camera username', autocomplete: 'off', autocapitalize: 'off', value: st.user || '', oninput: e => (st.user = e.target.value.trim()) }),
      h('input', { type: 'password', placeholder: 'Camera password', autocomplete: 'off', value: st.pass || '', oninput: e => (st.pass = e.target.value) })),
    r && h('span', { class: `vres ${r.ok ? 'ok' : 'bad'}` }, `${r.ok ? '✓' : '✗'} ${r.detail}${r.ok && r.brand ? ` (usual ${r.brand} address)` : ''}${r.ok && r.codec && !/H264/.test(r.codec) ? ' This camera sends ' + r.codec + ': if the picture does not show on the iPad, set its stream to H.264 in its settings.' : ''}`));
}

// "10.101.something" for a 255.255.0.0 network: the part of the address every device must share.
const samePart = n => { const k = n.netmask.split('.').filter(x => x === '255').length || 3; return `${n.address.split('.').slice(0, k).join('.')}${'.something'.repeat(4 - k)}`; };

// Loads the equipment list once; returns a "loading" card until it's here.
function setupLoading() {
  const st = S.setup;
  if (st && !st.loading) return null;
  if (!st) {
    S.setup = { loading: true, tests: {}, help: {} };
    ask('setup-get').then(r => {
      if (r.error) { toast(r.error, 6000); S.setup = null; return; }
      S.setup = { ...r, devices: JSON.parse(JSON.stringify(r.devices)), tests: {}, help: {}, dirty: false };
      if (['setup', 'wizard'].includes(S.tab)) render();
    });
  }
  return h('div', { class: 'card' }, 'Loading your equipment list…');
}
const redrawKeepScroll = () => { const m = $('#main'), y = m.scrollTop; render(); m.scrollTop = y; };

function addDevice(st, p, extra = {}) {
  const k = kindFor(st, { type: p.type, profile: p.id });
  let n = 1;
  while (st.devices.some(d => d.id === `${k.idBase}${n}`)) n++;
  const id = `${k.idBase}${n}`;
  const short = p.label.split(' (')[0].replace(/^ETC |^Yamaha |^Behringer /, '').split(' / ')[0];
  const d = { id, type: p.type, ...(p.id !== p.type ? { profile: p.id } : {}), name: `${short} ${n}`, host: '', ...JSON.parse(JSON.stringify(p.defaults || {})), ...extra };
  if (d.name.length > 28) d.name = `${short.slice(0, 24)} ${n}`;
  st.devices.push(d);
  st.dirty = true;
  return d;
}

async function testOne(st, d) {
  st.tests[d.id] = { running: true }; redrawKeepScroll();
  const r = await ask('setup-test', { device: d });
  st.tests[d.id] = r.error ? { ok: false, detail: r.error } : r; redrawKeepScroll();
}

// One piece of equipment: name, address, its own settings, test result, set-up steps.
function deviceCard(st, d, i, { open = false } = {}) {
  const k = kindFor(st, d);
  const t = st.tests[d.id];
  const edit = () => { st.dirty = true; delete st.tests[d.id]; };
  const fieldEl = ([key, type, label, ph]) => {
    const val = d[key] ?? '';
    if (type === 'video') return videoField(d, label, ph, edit, redrawKeepScroll);
    const set = v => { if (v === '' || v == null) delete d[key]; else d[key] = v; edit(); };
    let input;
    if (type.startsWith('select:')) {
      const opts = type.slice(7).split('|').map(o => o.split('='));
      input = h('select', { onchange: e => { set(e.target.value); redrawKeepScroll(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(val || opts[0][0]) === v }, l)));
    } else {
      const numeric = type === 'port' || type === 'number';
      input = h('input', { type: type === 'password' ? 'password' : 'text', inputmode: numeric ? 'numeric' : 'text', autocomplete: 'off', autocapitalize: 'off', value: val, placeholder: ph || '',
        onchange: e => set(numeric ? (e.target.value.trim() === '' ? '' : Number(e.target.value) || 0) : e.target.value.trim()) });
    }
    return h('label', {}, label, input);
  };
  const noHost = !d.host && !k.addressOptional;
  const showHelp = st.help[d.id] ?? open;
  return h('div', { class: `card dev ${noHost ? 'nohost' : ''}` },
    h('div', { class: 'devhead' },
      h('input', { class: 'name', value: d.name || '', 'aria-label': 'Name', oninput: e => { d.name = e.target.value; st.dirty = true; } }),
      h('span', { class: 'kind' }, k.label)),
    h('div', { class: 'form fields' },
      h('label', {}, k.addressOptional ? 'Address (optional)' : 'Address', h('input', { inputmode: 'decimal', autocomplete: 'off', autocapitalize: 'off', value: d.host || '', placeholder: 'e.g. 10.101.50.20',
        onchange: e => { d.host = e.target.value.trim(); edit(); redrawKeepScroll(); } })),
      k.fields.map(fieldEl)),
    h('div', { class: `result ${t ? (t.running ? 'run' : t.ok ? 'ok' : 'bad') : ''}` },
      t ? (t.running ? 'Testing… (up to 6 seconds)' : `${t.ok ? '✓' : '✗'} ${t.detail}`)
        : d.host ? 'Not tested yet' : k.addressOptional ? `No address: ${k.addressOptional}` : 'No address yet: this one is left out until it has one.'),
    h('div', { class: 'tools' },
      h('button', { class: 'always', disabled: noHost || t?.running, onclick: () => testOne(st, d) }, 'Test'),
      h('button', { class: 'always', onclick: () => { st.help[d.id] = !showHelp; redrawKeepScroll(); } }, showHelp ? 'Hide steps' : 'How to set it up'),
      h('button', { class: 'danger', onclick: () => { if (confirm(`Remove ${d.name}? Cue steps that use it will be skipped.`)) { st.devices.splice(i, 1); st.dirty = true; redrawKeepScroll(); } } }, 'Remove')),
    showHelp && h('ol', { class: 'steps' }, k.help.map(s => h('li', {}, s))));
}

// "Add equipment": search, or browse by kind. Calls onPick(profile).
function picker(st, onPick) {
  st.pick ||= { q: '' };
  const q = st.pick.q.trim().toLowerCase();
  const match = p => !q || `${p.label} ${p.keywords || ''} ${p.category}`.toLowerCase().includes(q);
  const box = h('div', { class: 'card picker' });
  const search = h('input', { type: 'search', placeholder: 'Type a make or model, e.g. Epson, X32, haze…', value: st.pick.q, autocapitalize: 'off', autocomplete: 'off',
    oninput: e => { st.pick.q = e.target.value; const pos = e.target.selectionStart; redrawKeepScroll(); const s = $('.picker input[type=search]'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } } });
  box.append(h('h3', {}, 'Add equipment'), search);
  let any = false;
  for (const [cat, title] of st.categories || []) {
    const list = (st.profiles || []).filter(p => p.category === cat && match(p));
    if (!list.length) continue;
    any = true;
    box.append(h('div', { class: 'pickcat' }, h('h4', {}, title),
      h('div', { class: 'picklist' }, list.map(p => h('button', { class: 'always', onclick: () => { st.pick = null; onPick(p); } }, p.label.replace(/ \(through Companion\)$/, ''),
        p.note && h('small', {}, p.note))))));
  }
  if (!any) box.append(h('p', { class: 'hint' }, 'Nothing by that name yet. Try "Anything that takes OSC", "text commands" or "Bitfocus Companion" under Anything else: between them they cover almost all show equipment. Or ask for it to be added.'));
  box.append(h('div', { class: 'tools', style: 'margin-top:10px' }, h('button', { class: 'always', onclick: () => { st.pick = null; st.picking = false; redrawKeepScroll(); } }, 'Close')));
  return box;
}

// "Find my equipment": what answered on the network, with an Add button for each.
async function runDiscover(st) {
  st.finding = { running: true }; redrawKeepScroll();
  const r = await ask('setup-discover', { devices: st.devices }, 45000);
  st.finding = r.error ? { error: r.error } : r; redrawKeepScroll();
}
const alreadyAdded = (st, f) => st.devices.find(d => d.host === f.host && (d.type === f.type || (d.profile && d.profile === f.profile)));
function foundCard(st, { onAdd } = {}) {
  const f = st.finding;
  if (!f) return null;
  if (f.running) return h('div', { class: 'card' }, h('h3', {}, 'Looking for equipment…'), h('p', { class: 'hint' }, 'Asking everything on the show network what it is. This takes about 10 seconds.'));
  if (f.error) return h('div', { class: 'card' }, h('p', { class: 'warnline' }, `Could not search: ${f.error}`));
  const add = x => {
    const p = (st.profiles || []).find(p => p.id === x.profile) || (st.profiles || []).find(p => p.type === x.type) || { id: x.type, type: x.type, label: x.label, defaults: {} };
    const d = addDevice(st, p, { host: x.host, ...(x.defaults || {}) });
    if (x.name) d.name = x.name.slice(0, 28);
    onAdd ? onAdd(d) : redrawKeepScroll();
  };
  const rows = f.found.map(x => {
    const have = alreadyAdded(st, x);
    return h('div', { class: 'foundrow' },
      h('div', {}, h('b', {}, x.label), x.name && h('span', {}, ` "${x.name}"`), h('div', { class: 'mono' }, x.host),
        h('div', { class: 'hint', style: 'margin:0' }, `${x.confidence === 'sure' ? 'It said what it is' : 'Probably: the right port is open'} (${x.detail}).`)),
      have ? h('span', { class: 'kind' }, `Added as ${have.name}`) : h('button', { class: 'primary always', onclick: () => add(x) }, 'Add'));
  });
  return h('div', { class: 'card' }, h('h3', {}, f.found.length ? `Found ${f.found.length} thing${f.found.length > 1 ? 's' : ''} on the network` : 'Nothing found yet'),
    rows.length ? h('div', { class: 'found' }, rows) : h('p', { class: 'hint' }, 'Nothing answered. Check this computer is plugged into the show network and the equipment is switched on and has an address. Some equipment cannot be found this way: add it from the list instead.'),
    f.found.length > 0 && h('p', { class: 'hint' }, 'Not everything can be found this way (some equipment stays quiet until it is set up). Add anything missing from the list.'),
    h('div', { class: 'tools', style: 'margin-top:10px' }, h('button', { class: 'always', onclick: () => runDiscover(st) }, 'Search again')));
}

function pluginCard(st) {
  const pl = st.plugins;
  if (!pl || (!pl.loaded?.length && !pl.errors?.length)) return null;
  return h('div', { class: 'card' }, h('h3', {}, 'Plugins'),
    pl.loaded.map(p => h('div', {}, `✓ ${p.label} `, h('span', { class: 'hint mono' }, p.file))),
    pl.errors.map(p => h('div', { class: 'warnline' }, `✗ ${p.file}: ${p.error}`)));
}

// Saves the equipment list: action "save", "go-live" or "practice". Returns false if cancelled.
async function saveSetupAs(st, action) {
  const live = st.mode === 'live';
  const noAddr = st.devices.filter(d => !d.host && !kindFor(st, d).addressOptional).map(d => d.name);
  const failed = st.devices.filter(d => (d.host || kindFor(st, d).addressOptional) && !st.tests[d.id]?.ok).map(d => d.name);
  if (action === 'go-live') {
    if (!st.devices.some(d => d.host || kindFor(st, d).addressOptional)) { toast('Type at least one address first', 4000); return false; }
    const notes = [noAddr.length && `No address yet (left out): ${noAddr.join(', ')}.`, failed.length && `Not tested or didn't answer: ${failed.join(', ')}.`].filter(Boolean);
    if (!confirm(`${notes.length ? notes.join('\n') + '\n\n' : ''}Go live? Show Control restarts with your real equipment (about 5 seconds). Your cue list comes with you.`)) return false;
  }
  if (action === 'practice' && !confirm('Back to practice mode? Show Control restarts with pretend equipment. Your equipment list and cue list are kept.')) return false;
  if (action === 'save' && live && !confirm('Save and restart Show Control (about 5 seconds)?')) return false;
  const r = await ask('setup-save', { action, name: st.name, pin: st.pin || '', devices: st.devices });
  if (r.error) { toast(`Not saved: ${r.error}`, 7000); return false; }
  if (st.pin) localStorage.setItem('pin', st.pin); // this iPad signs straight back in after the restart
  st.dirty = false;
  const names = r.missing?.length ? r.missing.map(id => st.devices.find(d => d.id === id)?.name || id) : [];
  if (names.length) toast(`Saved. Cue steps that use ${names.join(', ')} will be skipped until ${names.length > 1 ? 'they have addresses' : 'it has an address'}.`, 7000);
  else toast(r.restarting ? 'Saved. Restarting…' : st.mode === 'direct' ? 'Saved. Restart Show Control to use it.' : 'Saved', 4000);
  if (r.restarting) { st.restarting = true; S.setupRestart = true; }
  return true;
}

function setupTab() {
  const loading = setupLoading();
  if (loading) return loading;
  const st = S.setup;
  const wrap = h('div', { class: 'setup' });
  const practice = st.mode === 'practice', live = st.mode === 'live';
  const nets = st.networks || [];
  wrap.append(
    h('div', { class: `card mode ${practice ? 'practice' : 'live'}` },
      h('h3', {}, practice ? 'Practice mode' : live ? 'Live' : 'Equipment'),
      h('p', {}, practice
        ? 'Show Control is using pretend equipment, so nothing real moves. Fill in your real equipment below, test each one, then tap Go live. You can come back to practice at any time.'
        : live ? 'Show Control is controlling your real equipment. Changes here restart it (about 5 seconds), so make them before the show, not during it.'
          : 'Changes are saved to the show file. Restart Show Control afterwards to use them.'),
      h('button', { class: 'always', onclick: () => { S.tab = 'wizard'; S.wiz = null; render(); } }, 'Guided set-up, step by step')),
    h('div', { class: 'card' }, h('h3', {}, 'This computer on the network'),
      nets.length ? h('div', { class: 'kv' }, nets.map(n => [h('b', { class: 'mono' }, n.address), h('span', {}, n.name)]))
        : h('p', { class: 'warnline' }, 'This computer is not connected to a network. Plug it into the show network switch.'),
      h('p', { class: 'hint' }, nets.length
        ? `Every piece of equipment needs its own fixed address that starts the same way as this computer's (${samePart(nets[0])}), each one different, with subnet mask ${nets[0].netmask}.`
        : '')),
    h('div', { class: 'card form two' }, h('label', {}, 'Show name', h('input', { value: st.name || '', oninput: e => { st.name = e.target.value; st.dirty = true; } })),
      h('label', {}, practice ? 'PIN for iPads and phones (used when live)' : 'PIN for iPads and phones', h('input', { inputmode: 'numeric', autocomplete: 'off', value: st.pin || '', placeholder: 'none',
        oninput: e => { st.pin = e.target.value.trim(); st.dirty = true; } }))),
  );

  const testable = st.devices.filter(d => d.host || kindFor(st, d).addressOptional);
  wrap.append(h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin:14px 0 6px' },
    h('h3', { style: 'margin:0' }, 'Your equipment'),
    h('button', { class: 'always', style: 'flex:0 0 auto', disabled: !testable.length, onclick: () => testable.forEach(d => testOne(st, d)) }, 'Test all')),
  h('div', { class: 'equip' }, st.devices.map((d, i) => deviceCard(st, d, i))),
  st.picking ? picker(st, p => { const d = addDevice(st, p); st.help[d.id] = true; st.picking = false; redrawKeepScroll(); })
    : h('div', { class: 'card row' },
      h('button', { class: 'primary always', onclick: () => { st.picking = true; redrawKeepScroll(); } }, '+ Add equipment'),
      h('button', { class: 'always', disabled: st.finding?.running, onclick: () => runDiscover(st) }, 'Find equipment on the network')),
  foundCard(st), pluginCard(st));

  if (st.autostart) {
    wrap.append(h('div', { class: 'card' }, h('h3', {}, 'Always-on show computer'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.autostart.on, onchange: async e => {
        const r = await ask('autostart', { on: e.target.checked });
        if (r.error) { toast(r.error, 6000); e.target.checked = !e.target.checked; return; }
        st.autostart = r; toast(r.on ? 'Show Control will start when this computer starts' : 'Automatic start turned off');
      } }), ' Start Show Control automatically when this computer turns on'),
      h('p', { class: 'hint' }, st.autostart.platform === 'darwin'
        ? 'Leave the Show Control folder where it is now (the Applications folder is a good place: move it first, then turn this on). For a show server, also turn on automatic login: System Settings > Users & Groups. This computer is kept awake while Show Control runs.'
        : st.autostart.platform === 'win32' ? 'Leave the Show Control folder where it is now. For a show server, also set Windows to never sleep: Settings > System > Power.'
          : 'Leave the Show Control folder where it is now.')));
  }

  const save = async action => { if (await saveSetupAs(st, action) && !st.restarting) redrawKeepScroll(); };
  wrap.append(h('div', { class: 'sticky-save' },
    h('button', { class: 'always', onclick: () => { if (!st.dirty || confirm('Leave without saving?')) { S.setup = null; S.tab = 'sys'; render(); } } }, 'Back'),
    practice && h('button', { class: 'always', onclick: () => save('save') }, 'Save'),
    practice && h('button', { class: 'primary always', onclick: () => save('go-live') }, 'Go live ▶'),
    live && h('button', { class: 'always', onclick: () => save('practice') }, 'Back to practice'),
    !practice && h('button', { class: 'primary always', onclick: () => save('save') }, live ? 'Save and restart' : 'Save')));
  return wrap;
}

// The "Set up real equipment" card on the System tab.
function setupCard() {
  const practice = S.mode === 'practice';
  return h('div', { class: `card mode ${practice ? 'practice' : 'live'}`, style: 'grid-column:1/-1' },
    h('h3', {}, practice ? 'Practice mode: pretend equipment' : S.mode === 'live' ? 'Live: real equipment' : 'Equipment'),
    h('p', {}, practice ? 'Nothing real is being controlled. When your gear is on the network, set it up here and go live.'
      : 'Addresses and settings for your lighting, sound, QLab, cameras and projectors.'),
    h('div', { class: 'row' },
      h('button', { class: practice ? 'primary always' : 'always', onclick: () => { S.setup = null; S.tab = 'setup'; render(); } }, practice ? 'Set up real equipment' : 'Equipment setup'),
      h('button', { class: 'always', onclick: () => { S.setup = null; S.wiz = null; S.tab = 'wizard'; render(); } }, 'Guided set-up')));
}
$('#conn').addEventListener('click', () => { if (S.mode === 'practice') { S.setup = null; S.tab = 'setup'; render(); } });
