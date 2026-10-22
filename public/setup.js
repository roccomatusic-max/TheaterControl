// ---------- Setup: switch from practice (pretend gear) to the real equipment ----------
'use strict';
// Each kind of equipment: what to ask for, and how to turn on network control on the device itself.
// Field: [key, type, label, placeholder]; types: text, password, port, select:value=Label|value=Label
const KINDS = {
  eos: {
    label: 'ETC Eos lighting console', idBase: 'eos', fields: [],
    help: [
      'Plug the console\'s network port into the show network switch.',
      'Exit Eos to the Shell (the start-up screen), then open Settings > Network. Give that port a fixed address, for example 192.168.1.10, and tick "UDP Strings & OSC" under Interface Protocols.',
      'Start Eos again. Go to Setup > System > Show Control > OSC and turn on OSC RX and OSC TX.',
      'Type the console\'s address in the Address box and tap Test.',
    ],
  },
  'yamaha-tf': {
    label: 'Yamaha TF mixer', idBase: 'mixer', fields: [],
    help: [
      'Plug the NETWORK port on the back of the TF5 into the show network switch.',
      'On the TF5 screen open Setup, then Network. Choose a fixed (static) address, for example 192.168.1.20, with subnet mask 255.255.255.0.',
      'Type the same address in the Address box and tap Test. (TF Editor and StageMix use the same setting, so if those work, this will too.)',
    ],
  },
  qlab: {
    label: 'QLab', idBase: 'qlab', fields: [['passcode', 'password', 'QLab passcode (only if you set one)', '']],
    help: [
      'On the QLab Mac, give its network connection a fixed address in System Settings > Network (for example 192.168.1.30). If QLab runs on this same computer, use 127.0.0.1.',
      'Open your show in QLab. Click the gear icon (Workspace Settings), then Network (QLab 5) or OSC Controls (QLab 4), and make sure OSC access is allowed.',
      'If you set an OSC passcode there, it needs Control permission. Type it in the passcode box.',
      'If the Mac asks whether QLab may accept incoming connections, click Allow. Then tap Test.',
    ],
  },
  ptz: {
    label: 'PTZ camera', idBase: 'cam',
    fields: [['protocol', 'select:visca-ip=VISCA over IP (Sony, BirdDog and most others)|visca-tcp=VISCA over TCP (PTZOptics, Lumens)', 'Control method'],
      ['port', 'port', 'Port (leave empty for the usual one)', '52381 or 5678']],
    help: [
      'Plug the camera into the show network switch (PoE cameras get their power from it too).',
      'Find the camera\'s address (its manual, its on-screen menu, or the maker\'s finder app) and type it into a web browser to open its settings page.',
      'In its network settings, choose a fixed (static) address, and make sure VISCA over IP is turned on. Note the port number it shows.',
      'Type the address in the Address box, pick the control method that matches, and tap Test.',
    ],
  },
  panasonic: {
    label: 'Panasonic projector', idBase: 'proj',
    fields: [['model', 'select:pt-dz13k=PT-DZ13K series|pt-dz770=PT-DZ770 series', 'Model'], ['username', 'text', 'Username', 'admin1'], ['password', 'password', 'Password', '']],
    help: [
      'Plug the projector\'s LAN port into the show network switch.',
      'In the projector\'s on-screen menu: NETWORK > NETWORK SETUP. Turn DHCP off and set a fixed address, for example 192.168.1.41.',
      'NETWORK > NETWORK CONTROL: turn COMMAND CONTROL on.',
      'Set STANDBY MODE to NORMAL (not ECO), so the projector still answers when it is switched off.',
      'The username and password are the ones for the projector\'s web page (often admin1 / panasonic from the factory). Type them in the boxes and tap Test.',
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
const kindLabel = t => KINDS[t]?.label || t;

function ask(t, payload = {}, ms = 20000) {
  const id = ++cmdSeq;
  send({ t, id, ...payload });
  return new Promise(res => {
    pending[id] = r => res(typeof r === 'string' ? { error: r } : r === true ? {} : r);
    setTimeout(() => { if (pending[id]) { delete pending[id]; res({ error: 'No answer from Show Control' }); } }, ms);
  });
}

function setupTab() {
  const st = S.setup;
  const wrap = h('div', { class: 'setup' });
  if (!st || st.loading) {
    if (!st) {
      S.setup = { loading: true, tests: {}, help: {} };
      ask('setup-get').then(r => {
        if (r.error) { toast(r.error, 6000); S.setup = null; return; }
        S.setup = { ...r, devices: JSON.parse(JSON.stringify(r.devices)), tests: {}, help: {}, dirty: false };
        if (S.tab === 'setup') render();
      });
    }
    return h('div', { class: 'card' }, 'Loading your equipment list…');
  }
  const redraw = () => { const m = $('#main'), y = m.scrollTop; render(); m.scrollTop = y; };
  const edit = () => { st.dirty = true; };

  const practice = st.mode === 'practice', live = st.mode === 'live';
  const nets = st.networks || [];
  wrap.append(
    h('div', { class: `card mode ${practice ? 'practice' : 'live'}` },
      h('h3', {}, practice ? 'Practice mode' : live ? 'Live' : 'Equipment'),
      h('p', {}, practice
        ? 'Show Control is using pretend equipment, so nothing real moves. Fill in your real equipment below, test each one, then tap Go live. You can come back to practice at any time.'
        : live ? 'Show Control is controlling your real equipment. Changes here restart it (about 5 seconds), so make them before the show, not during it.'
          : 'Changes are saved to the show file. Restart Show Control afterwards to use them.')),
    h('div', { class: 'card' }, h('h3', {}, 'This computer on the network'),
      nets.length ? h('div', { class: 'kv' }, nets.map(n => [h('b', { class: 'mono' }, n.address), h('span', {}, n.name)]))
        : h('p', { class: 'warnline' }, 'This computer is not connected to a network. Plug it into the show network switch.'),
      h('p', { class: 'hint' }, nets.length
        ? `Every piece of equipment needs its own address that starts the same way as this computer's (for example ${nets[0].address.split('.').slice(0, 3).join('.')}.something), each ending in a different number.`
        : '')),
    h('div', { class: 'card form' }, h('label', {}, 'Show name', h('input', { value: st.name || '', oninput: e => { st.name = e.target.value; edit(); } }))),
  );

  // Equipment list
  const testOne = async d => {
    st.tests[d.id] = { running: true }; redraw();
    const r = await ask('setup-test', { device: d });
    st.tests[d.id] = r.error ? { ok: false, detail: r.error } : r; redraw();
  };
  const list = h('div', { class: 'equip' });
  st.devices.forEach((d, i) => {
    const k = KINDS[d.type] || { label: d.type, fields: [], help: [] };
    const t = st.tests[d.id];
    const fieldEl = ([key, type, label, ph]) => {
      const val = d[key] ?? '';
      const set = v => { if (v === '' || v == null) delete d[key]; else d[key] = v; edit(); delete st.tests[d.id]; };
      let input;
      if (type.startsWith('select:')) {
        const opts = type.slice(7).split('|').map(o => o.split('='));
        input = h('select', { onchange: e => set(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: (val || opts[0][0]) === v }, l)));
      } else input = h('input', { type: type === 'password' ? 'password' : 'text', inputmode: type === 'port' ? 'numeric' : 'text', autocomplete: 'off', autocapitalize: 'off', value: val, placeholder: ph || '',
        onchange: e => set(type === 'port' ? (Number(e.target.value) || '') : e.target.value.trim()) });
      return h('label', {}, label, input);
    };
    list.append(h('div', { class: `card dev ${d.enabled === false && !d.host ? 'nohost' : ''}` },
      h('div', { class: 'devhead' },
        h('input', { class: 'name', value: d.name || '', 'aria-label': 'Name', oninput: e => { d.name = e.target.value; edit(); } }),
        h('span', { class: 'kind' }, k.label)),
      h('div', { class: 'form fields' },
        h('label', {}, 'Address', h('input', { inputmode: 'decimal', autocomplete: 'off', autocapitalize: 'off', value: d.host || '', placeholder: 'e.g. 192.168.1.20',
          onchange: e => { d.host = e.target.value.trim(); edit(); delete st.tests[d.id]; redraw(); } })),
        k.fields.map(fieldEl)),
      h('div', { class: `result ${t ? (t.running ? 'run' : t.ok ? 'ok' : 'bad') : ''}` },
        t ? (t.running ? 'Testing… (up to 6 seconds)' : `${t.ok ? '✓' : '✗'} ${t.detail}`) : d.host ? 'Not tested yet' : 'No address yet: this one is left out until it has one.'),
      h('div', { class: 'tools' },
        h('button', { class: 'always', disabled: !d.host || t?.running, onclick: () => testOne(d) }, 'Test'),
        h('button', { class: 'always', onclick: () => { st.help[d.id] = !st.help[d.id]; redraw(); } }, st.help[d.id] ? 'Hide steps' : 'How to set it up'),
        h('button', { class: 'danger', onclick: () => { if (confirm(`Remove ${d.name}? Cue steps that use it will be skipped.`)) { st.devices.splice(i, 1); edit(); redraw(); } } }, 'Remove')),
      st.help[d.id] && h('ol', { class: 'steps' }, k.help.map(s => h('li', {}, s)))));
  });
  const addSel = h('select', {}, h('option', { value: '' }, 'Add equipment…'), Object.entries(KINDS).map(([t, k]) => h('option', { value: t }, k.label)));
  addSel.onchange = () => {
    const t = addSel.value; if (!t) return;
    const base = KINDS[t].idBase; let n = 1;
    while (st.devices.some(d => d.id === `${base}${n}`)) n++;
    const id = `${base}${n}`;
    st.devices.push({ id, type: t, name: `${KINDS[t].label.split(' (')[0].replace(/^ETC |^Yamaha /, '')} ${n}`, host: '', ...(t === 'panasonic' ? { model: 'pt-dz13k', username: 'admin1' } : t === 'ptz' ? { protocol: 'visca-ip', presets: [] } : {}) });
    st.help[id] = true; edit(); redraw();
  };
  const testable = st.devices.filter(d => d.host);
  wrap.append(h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin:14px 0 6px' },
    h('h3', { style: 'margin:0' }, 'Your equipment'),
    h('button', { class: 'always', style: 'flex:0 0 auto', disabled: !testable.length, onclick: () => testable.forEach(testOne) }, 'Test all')), list, h('div', { class: 'card' }, addSel));

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

  // Save / go live
  const save = async action => {
    const noAddr = st.devices.filter(d => !d.host).map(d => d.name);
    const failed = st.devices.filter(d => d.host && !st.tests[d.id]?.ok).map(d => d.name);
    if (action === 'go-live') {
      if (!st.devices.some(d => d.host)) return toast('Type at least one address first', 4000);
      const notes = [noAddr.length && `No address yet (left out): ${noAddr.join(', ')}.`, failed.length && `Not tested or didn't answer: ${failed.join(', ')}.`].filter(Boolean);
      if (!confirm(`${notes.length ? notes.join('\n') + '\n\n' : ''}Go live? Show Control restarts with your real equipment (about 5 seconds). Your cue list comes with you.`)) return;
    }
    if (action === 'practice' && !confirm('Back to practice mode? Show Control restarts with pretend equipment. Your equipment list and cue list are kept.')) return;
    if (action === 'save' && live && !confirm('Save and restart Show Control (about 5 seconds)?')) return;
    const r = await ask('setup-save', { action, name: st.name, devices: st.devices });
    if (r.error) return toast(`Not saved: ${r.error}`, 7000);
    st.dirty = false;
    const names = r.missing?.length ? r.missing.map(id => st.devices.find(d => d.id === id)?.name || id) : [];
    if (names.length) toast(`Saved. Cue steps that use ${names.join(', ')} will be skipped until ${names.length > 1 ? 'they have addresses' : 'it has an address'}.`, 7000);
    else toast(r.restarting ? 'Saved. Restarting…' : st.mode === 'direct' ? 'Saved. Restart Show Control to use it.' : 'Saved', 4000);
    if (r.restarting) { st.restarting = true; S.setupRestart = true; }
    else redraw();
  };
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
    h('button', { class: practice ? 'primary always' : 'always', onclick: () => { S.setup = null; S.tab = 'setup'; render(); } }, practice ? 'Set up real equipment' : 'Equipment setup'));
}
$('#conn').addEventListener('click', () => { if (S.mode === 'practice') { S.setup = null; S.tab = 'setup'; render(); } });
