// ---------- Cameras and video ----------
// Live view (player.js), camera control, multi-view, pop-out, night view, recording with cue
// markers, snapshot notes, TV screens and phone cameras, the focus helper and projection checks.
'use strict';
const PTZ_TYPES = ['ptz', 'panasonic-cam']; // cameras that move
const CAM_TYPES = [...PTZ_TYPES, 'camera'];
const cameras = () => Object.values(S.devices).filter(d => CAM_TYPES.includes(d.type));
const shortName = d => (d?.name || '').split(' · ')[0];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };

function askServer(t, payload = {}, ms = 20000) {
  const id = ++cmdSeq;
  send({ t, id, ...payload });
  return new Promise(res => {
    pending[id] = r => res(typeof r === 'string' ? { error: r } : r);
    setTimeout(() => { if (pending[id]) { delete pending[id]; res({ error: 'No answer from Show Control' }); } }, ms);
  });
}

extraHandlers.push(m => {
  if (m.t === 'init') {
    // the token lets this browser load video, recordings and notes pictures over plain HTTP
    document.cookie = `sc=${m.token}; path=/; SameSite=Strict`;
    S.video = m.video || {}; S.rec = m.rec || {}; S.viewKey = m.viewKey || '';
  } else if (m.t === 'video') { S.video = m.video; (updaters.__video || []).forEach(f => f()); }
  else if (m.t === 'rec') { S.rec = m.rec; (updaters.__rec || []).forEach(f => f()); }
  else if (m.t === 'notes-changed') (updaters.__notes || []).forEach(f => f());
  else if (m.t === 'device' && !S.devices[m.device.id] && CAM_TYPES.includes(m.device.type)) setTimeout(() => ['cam', 'show'].includes(S.tab) && render()); // a phone camera arrived
  else if (m.t === 'device-removed') { delete S.devices[m.id]; if (['cam', 'show'].includes(S.tab)) render(); else renderDots(); }
});

// ---------- the picture ----------
function simView(camId) {
  // Stand-in for a real video feed: a virtual stage that pans/zooms with the simulated camera.
  const c = h('canvas', { width: 640, height: 360 });
  const g = c.getContext('2d');
  const draw = () => {
    if (!c.isConnected) return;
    const st = S.devices[camId]?.state || {};
    const pan = (st.pan || 0) / 2448, tilt = (st.tilt || 0) / 1296, z = 1 + (st.zoom || 0) / 0x4000 * 5;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#05070a'; g.fillRect(0, 0, 640, 360);
    g.translate(320, 180); g.scale(z, z); g.translate(-pan * 600, tilt * 200);
    g.fillStyle = '#2b1d14'; g.fillRect(-700, 40, 1400, 160);               // stage deck
    g.fillStyle = '#5b0f14'; g.fillRect(-720, -260, 120, 300); g.fillRect(600, -260, 120, 300); // proscenium legs
    const t = performance.now() / 1000;
    [[-300, '#ffd27a'], [0, '#9ad1ff'], [300, '#ff9ad5']].forEach(([x, col], i) => {
      const grd = g.createRadialGradient(x, 120, 5, x, 120, 120); grd.addColorStop(0, col + 'aa'); grd.addColorStop(1, '#0000');
      g.fillStyle = grd; g.fillRect(x - 120, 0, 240, 240);
      g.fillStyle = '#ddd'; const bob = Math.sin(t * 2 + i) * 4;
      g.beginPath(); g.arc(x, 40 + bob, 12, 0, 7); g.fill(); g.fillRect(x - 10, 54 + bob, 20, 50);
    });
    g.fillStyle = '#111'; g.fillRect(-250, 200, 500, 80);                    // pit
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff8'; g.font = '13px monospace';
    g.fillText(`SIM ${camId}  P${st.pan ?? '-'} T${st.tilt ?? '-'} Z${st.zoom ?? '-'}`, 10, 20);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return c;
}
// → { el, media } where media is the <video>/<canvas> a snapshot can be taken from (null for web pages)
function videoEl(cam) {
  const s = cam.state.stream || {};
  const media = el => ({ el, media: el });
  switch (s.type) {
    case 'sim': return media(simView(cam.id));
    case 'live': { const p = LiveVideo.create(s.src || cam.id); return { el: p.el, media: p.video }; }
    case 'go2rtc': return { el: h('iframe', { src: `${s.url}/stream.html?src=${encodeURIComponent(s.src || cam.id)}&mode=webrtc,mse,hls,mjpeg`, allow: 'autoplay; fullscreen' }), media: null };
    case 'mediamtx': return { el: h('iframe', { src: `${s.url}/${encodeURIComponent(s.src || cam.id)}`, allow: 'autoplay; fullscreen' }), media: null };
    case 'mjpeg': return media(h('img', { src: s.url, alt: cam.name, crossorigin: 'anonymous' }));
    case 'hls': return media(h('video', { src: s.url, autoplay: '', muted: '', playsinline: '', controls: '' }));
    case 'iframe': return { el: h('iframe', { src: s.url, allow: 'autoplay; fullscreen' }), media: null };
    default: return { el: h('div', { class: 'vmsg' }, PTZ_TYPES.includes(cam.type) ? 'No video address yet. Add one in System > Equipment setup (Find video does it for you).' : 'No video configured'), media: null };
  }
}

// Camera picture with its tools: snapshot to notes, pop out (picture in picture), night view, full screen.
function camView(cam, { tools = true } = {}) {
  const v = videoEl(cam);
  const view = h('div', { class: 'view' }, v.el, h('div', { class: 'osd' }, cam.name));
  const nightKey = `night:${cam.id}`;
  const setNight = on => { view.classList.toggle('night', on); store.set(nightKey, on ? '1' : null); };
  setNight(store.get(nightKey) ? true : !!S.devices[cam.id]?.state.night && cam.type === 'camera');
  onDevice(cam.id, d => view.classList.toggle('tally', !!d.state.tally));
  if (!tools) return view;
  const isVideo = v.media?.tagName === 'VIDEO';
  view.append(h('div', { class: 'vtools' },
    v.media && h('button', { class: 'always', title: 'Snapshot to notes', onclick: () => snapNote(cam, v.media) }, '📷'),
    isVideo && (document.pictureInPictureEnabled || v.media.webkitSupportsPresentationMode) && h('button', { class: 'always', title: 'Pop out: keep watching on other tabs', onclick: () => popOut(v.media) }, '⧉'),
    h('button', { class: 'always', title: 'Low-light view: brightens the picture for dark backstage areas', onclick: () => setNight(!view.classList.contains('night')) }, '🔆'),
    h('button', { class: 'always', title: 'Full screen', onclick: () => fullScreen(view, v.media) }, '⤢')));
  return view;
}
function popOut(video) {
  if (document.pictureInPictureElement === video) return document.exitPictureInPicture();
  if (video.requestPictureInPicture) return video.requestPictureInPicture().catch(e => toast(`Can't pop out: ${e.message}`));
  if (video.webkitSetPresentationMode) video.webkitSetPresentationMode('picture-in-picture');
}
function fullScreen(view, media) {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (view.requestFullscreen) return view.requestFullscreen().catch(() => media?.webkitEnterFullscreen?.());
  if (view.webkitRequestFullscreen) return view.webkitRequestFullscreen();
  media?.webkitEnterFullscreen?.(); // iPhone: only the video itself can go full screen
}

// ---------- camera control ----------
function joystick(onVec) {
  const knob = h('div', { class: 'knob' });
  const el = h('div', { class: 'joy' }, knob);
  let active = false, vec = [0, 0], timer;
  const setFrom = e => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    vec = [x, -y]; knob.style.transform = `translate(${x * R * 0.6}px, ${y * R * 0.6}px)`;
  };
  el.addEventListener('pointerdown', e => { active = true; el.setPointerCapture(e.pointerId); setFrom(e); onVec(...vec); timer = setInterval(() => onVec(...vec), 120); });
  el.addEventListener('pointermove', e => active && setFrom(e));
  const end = () => { if (!active) return; active = false; clearInterval(timer); knob.style.transform = ''; onVec(0, 0); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  return el;
}
function holdBtn(label, onDown, onUp) {
  const b = h('button', {}, label);
  b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); onDown(); });
  b.addEventListener('pointerup', onUp); b.addEventListener('pointercancel', onUp);
  return b;
}
// Repeats while held (for nudging): fires at once, then every `ms`.
function repeatBtn(label, fn, ms = 150, attrs = {}) {
  let t;
  const b = h('button', attrs, label);
  const stop = () => clearInterval(t);
  b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); fn(); clearInterval(t); t = setInterval(fn, ms); });
  b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop);
  return b;
}
const presetsOf = d => (d.state.presets?.length ? d.state.presets : [1, 2, 3, 4, 5, 6].map(n => ({ n, label: `P${n}` })));

function camCard(cam, expanded) {
  const card = h('div', { class: 'card' }, h('h3', {}, cam.name, statusPill(cam.id)), camView(cam));
  if (!expanded || !PTZ_TYPES.includes(cam.type)) return card;
  const presets = h('div', { class: 'presets' });
  onDevice(cam.id, d => presets.replaceChildren(...presetsOf(d).map(p => {
    const b = h('button', { class: d.state.lastPreset === p.n ? 'cur' : '' }, p.label);
    let t; // tap = recall, long-press = store
    b.addEventListener('pointerdown', () => { t = setTimeout(() => { t = null; if (confirm(`Store current shot as "${p.label}" on ${cam.name}?`)) cmd(cam.id, 'store', { preset: p.n }); }, 800); });
    b.addEventListener('pointerup', () => { if (t) { clearTimeout(t); cmd(cam.id, 'preset', { preset: p.n }); } });
    b.addEventListener('pointercancel', () => clearTimeout(t));
    return b;
  })));
  card.classList.add('camfull');
  card.append(h('div', { class: 'camctl' },
    joystick((x, y) => cmd(cam.id, 'move', { pan: x, tilt: y })),
    h('div', { class: 'camside' },
      h('div', { class: 'zoom' }, holdBtn('Zoom −', () => cmd(cam.id, 'zoom', { speed: -0.6 }), () => cmd(cam.id, 'zoom', { speed: 0 })),
        holdBtn('Zoom +', () => cmd(cam.id, 'zoom', { speed: 0.6 }), () => cmd(cam.id, 'zoom', { speed: 0 })),
        h('button', { onclick: () => cmd(cam.id, 'home') }, 'Home')),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { onclick: () => cmd(cam.id, 'focus', { mode: 'auto' }) }, 'AF'),
        h('button', { onclick: () => cmd(cam.id, 'focus', { mode: 'onepush' }) }, 'Push AF'),
        h('button', { onclick: () => cmd(cam.id, 'tally', { on: !S.devices[cam.id].state.tally }) }, 'Tally'),
        cam.type === 'ptz' && h('button', { title: 'Infrared night mode, on cameras that have it', onclick: () => cmd(cam.id, 'night', { on: !S.devices[cam.id].state.night }) }, 'IR')),
      presets)));
  return card;
}

// ---------- Cameras tab ----------
const fmtBytes = b => (b == null ? '—' : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
function recBar() {
  const el = h('div', { class: 'recbar' });
  const draw = () => {
    const r = S.rec || {};
    const running = r.on ? fmtDur(Date.now() + S.clockSkew - r.started) : '';
    el.replaceChildren(
      h('button', { class: `always ${r.on ? 'recording' : ''}`, onclick: async () => {
        if (r.on && !confirm('Stop recording?')) return;
        const x = await askServer('rec', { action: r.on ? 'stop' : 'start' });
        if (x.error) toast(x.error, 5000);
      } }, r.on ? `■ Stop  ${running}` : '● Record'),
      h('span', { class: 'dim' }, r.on ? `${r.cams.length ? r.cams.map(c => `${shortName(c)} ${fmtBytes(c.bytes)}${c.ok ? '' : ' (waiting)'}`).join(' · ') : 'no cameras with video: cue markers only'} · ${r.markers} markers`
        : `Records every camera with video, with a marker at each cue.${r.free != null ? ` ${fmtBytes(r.free)} free.` : ''}`),
      h('label', { class: 'switch small' }, h('input', { type: 'checkbox', checked: !!r.auto, onchange: e => askServer('rec', { action: 'auto', on: e.target.checked }) }), 'Record when the show timer starts'));
  };
  (updaters.__rec ||= []).push(draw);
  (updaters.__tick ||= []).push(() => S.rec?.on && (el.firstChild.textContent = `■ Stop  ${fmtDur(Date.now() + S.clockSkew - S.rec.started)}`));
  draw();
  return el;
}
function followSwitch() {
  const input = h('input', { type: 'checkbox', checked: S.show.camFollow !== false, onchange: e => send({ t: 'cam-follow', on: e.target.checked }) });
  (updaters.__show ||= []).push(sh => (input.checked = sh.camFollow !== false));
  return h('label', { class: 'switch small', title: 'Off: cue steps that move cameras are skipped, so you can drive them by hand' }, input, 'Cameras follow cues');
}

function camTab() {
  const cams = cameras();
  S.camSel ||= cams[0]?.id || 'recordings';
  if (!['all', 'recordings', 'notes'].includes(S.camSel) && !S.devices[S.camSel]) S.camSel = cams[0]?.id || 'recordings';
  const pick = id => { S.camSel = id; render(); };
  const tabs = h('div', { class: 'row', style: 'margin-bottom:10px' },
    cams.length > 1 && h('button', { class: S.camSel === 'all' ? 'on always' : 'always', onclick: () => pick('all') }, 'All'),
    cams.map(c => h('button', { class: S.camSel === c.id ? 'on always' : 'always', onclick: () => pick(c.id) }, shortName(c))),
    h('button', { class: S.camSel === 'recordings' ? 'on always' : 'always', onclick: () => pick('recordings') }, 'Recordings'),
    h('button', { class: S.camSel === 'notes' ? 'on always' : 'always', onclick: () => pick('notes') }, 'Notes'));
  const top = h('div', { class: 'card', style: 'margin-bottom:10px' }, recBar(), h('div', { class: 'row', style: 'align-items:center;margin-top:6px' }, followSwitch(), videoStatus()));
  if (S.camSel === 'recordings') return h('div', {}, tabs, top, recordingsView());
  if (S.camSel === 'notes') return h('div', {}, tabs, notesView());
  if (!cams.length) return h('div', {}, tabs, top, h('div', { class: 'card' }, 'No cameras yet. Add them in System > Equipment setup, or send a spare phone\'s camera (System > Camera screens and phone cameras).'));
  if (S.camSel === 'all') return h('div', {}, tabs, top, multiView(cams));
  return h('div', {}, tabs, top, camCard(S.devices[S.camSel], true));
}
function videoStatus() {
  const el = h('span', { class: 'dim', style: 'margin-left:auto;font-size:13px' });
  const draw = () => { const s = S.video?.status; el.textContent = s === 'running' ? '' : s === 'missing' ? 'Live video relay not installed (see README)' : s === 'failed' ? 'Live video relay stopped, restarting…' : s === 'starting' ? 'Live video starting…' : ''; };
  (updaters.__video ||= []).push(draw); draw();
  return el;
}

// Several cameras at once: an even grid, or one big picture with the others small beside it.
function multiView(cams) {
  const layout = store.get('camLayout') || 'grid';
  const big = S.devices[store.get('camBig')] ? store.get('camBig') : cams[0].id;
  const bar = h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('button', { class: layout === 'grid' ? 'on always' : 'always', onclick: () => { store.set('camLayout', 'grid'); render(); } }, 'Grid'),
    h('button', { class: layout === 'focus' ? 'on always' : 'always', onclick: () => { store.set('camLayout', 'focus'); render(); } }, 'One big'));
  if (layout === 'grid') return h('div', {}, bar, h('div', { class: 'cams' }, cams.map(c => camCard(c, false))));
  const small = cams.filter(c => c.id !== big).map(c => h('div', { class: 'card small', onclick: e => { if (e.target.closest('.vtools')) return; store.set('camBig', c.id); render(); } },
    h('h3', {}, shortName(c), h('span', { class: 'dim' }, 'tap to swap')), camView(c, { tools: false })));
  return h('div', {}, bar, h('div', { class: 'focuslayout' }, camCard(S.devices[big], false), h('div', { class: 'strip-cams' }, small)));
}

// A camera on the Show tab, so the stage is in view while calling the show.
function showCamTile() {
  const cams = cameras();
  if (!cams.length) return null;
  const id = store.get('showCam');
  const sel = h('select', { onchange: e => { store.set('showCam', e.target.value || null); render(); } },
    h('option', { value: '' }, 'No camera'), cams.map(c => h('option', { value: c.id, selected: c.id === id }, c.name)));
  const cam = S.devices[id];
  return h('div', { class: 'card' }, h('h3', {}, 'Camera', sel), cam ? camView(cam) : h('p', { class: 'dim', style: 'margin:0' }, 'Pick a camera to keep the stage in view here.'));
}

// ---------- recordings ----------
function recordingsView() {
  const wrap = h('div', {});
  if (S.recOpen) { wrap.append(playback(S.recOpen)); return wrap; }
  wrap.append(h('div', { class: 'card' }, 'Loading recordings…'));
  askServer('rec', { action: 'list' }).then(list => {
    if (list.error) return wrap.replaceChildren(h('div', { class: 'card' }, list.error));
    wrap.replaceChildren(list.length ? h('div', { class: 'reclist' }, list.map(r => h('div', { class: 'card' },
      h('h3', {}, new Date(r.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), r.live && h('span', { class: 'pill off' }, 'recording')),
      h('div', {}, r.show), h('div', { class: 'dim' }, `${r.live ? 'still recording' : fmtDur(r.ended - r.started)} · ${r.cams} camera${r.cams === 1 ? '' : 's'} · ${r.markers} markers · ${fmtBytes(r.bytes)}`),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'always', onclick: () => { S.recOpen = r.folder; render(); } }, 'Watch'),
        !r.live && h('button', { class: 'danger', onclick: async () => {
          if (!confirm(`Delete the recording from ${new Date(r.started).toLocaleString()}? This can't be undone.`)) return;
          const x = await askServer('rec', { action: 'delete', folder: r.folder }); if (x.error) toast(x.error); else render();
        } }, 'Delete'))))) : h('div', { class: 'card' }, h('p', { style: 'margin:0' }, 'No recordings yet. Tap ● Record, or turn on "Record when the show timer starts".'),
      h('p', { class: 'hint' }, 'Recordings are saved in the Show Control folder on the show computer, in Recordings.')));
  });
  return wrap;
}
function playback(folder) {
  const wrap = h('div', { class: 'card' }, 'Loading…');
  askServer('rec', { action: 'get', folder }).then(r => {
    if (r.error) { S.recOpen = null; return wrap.replaceChildren(r.error); }
    const cams = r.cams.filter(c => c.files.length);
    let cam = cams[0];
    const video = h('video', { controls: '', playsinline: '', preload: 'metadata' });
    const fileUrl = f => `recordings/${encodeURIComponent(folder)}/${encodeURIComponent(f.file)}`;
    let cur = null;
    // Jump to a moment (ms from the start of the recording) in the current camera.
    const seek = t => {
      if (!cam) return;
      const f = cam.files.find(x => t >= x.start && t <= (x.end ?? Infinity)) || cam.files.filter(x => x.start <= t).pop() || cam.files[0];
      const at = Math.max(0, (t - f.start) / 1000 - 2); // 2 s before the marker
      if (cur !== f) { cur = f; video.src = fileUrl(f); video.addEventListener('loadedmetadata', () => { video.currentTime = at; video.play().catch(() => {}); }, { once: true }); }
      else { video.currentTime = at; video.play().catch(() => {}); }
    };
    const camBtns = h('div', { class: 'row' });
    const drawCams = () => camBtns.replaceChildren(...cams.map(c => h('button', { class: c === cam ? 'on always' : 'always', onclick: () => {
      const t = cur ? cur.start + video.currentTime * 1000 + 2000 : 0; cam = c; cur = null; drawCams(); seek(t);
    } }, shortName(c))));
    drawCams();
    const KIND = { cue: 'GO', note: 'Note', mark: 'Mark' };
    wrap.replaceChildren(
      h('h3', {}, `${r.show} · ${new Date(r.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, h('button', { class: 'always', onclick: () => { S.recOpen = null; render(); } }, '← All recordings')),
      cams.length ? h('div', { class: 'playback' },
        h('div', {}, h('div', { class: 'view' }, video), camBtns,
          h('p', { class: 'hint' }, 'Files are in the Show Control folder on the show computer, under Recordings. ', cam && h('a', { href: fileUrl(cam.files[0]), download: '' }, 'Download this camera'))),
        h('div', { class: 'markers' }, r.markers.length ? r.markers.map(mk => h('button', { class: `always mk ${mk.kind}`, onclick: () => seek(mk.t) },
          h('span', { class: 'mono' }, fmtDur(mk.t)), h('b', {}, KIND[mk.kind] || mk.kind), h('span', {}, mk.label))) : h('p', { class: 'dim' }, 'No cues were fired during this recording.')))
        : h('p', {}, 'No video was recorded (no camera had video). Cue times: ', r.markers.map(mk => `${fmtDur(mk.t)} ${mk.label}`).join(' · ')));
    if (cam) seek(0);
  });
  return wrap;
}

// ---------- notes with snapshots ----------
function snapNote(cam, media) {
  const image = LiveVideo.snapshot(media);
  if (!image) return toast('No picture to grab yet');
  noteDialog({ image, cam: cam.id, title: `Snapshot · ${cam.name}` });
}
function noteDialog({ image, cam, title = 'New note' }) {
  const text = h('textarea', { rows: 3, placeholder: 'What needs fixing? e.g. "DSL special is late"' });
  const close = () => dlg.remove();
  const save = async () => {
    const r = await askServer('notes', { action: 'add', text: text.value, image, cam });
    if (r.error) return toast(`Not saved: ${r.error}`, 5000);
    toast('Note saved'); close();
  };
  const dlg = h('div', { class: 'modal', onclick: e => e.target === dlg && close() }, h('div', { class: 'card form' },
    h('h3', {}, title), image && h('img', { src: image, class: 'snap' }), text,
    h('div', { class: 'row' }, h('button', { class: 'always', onclick: close }, 'Cancel'), h('button', { class: 'primary always', onclick: save }, 'Save note'))));
  document.body.append(dlg);
  text.focus();
}
function notesView() {
  const wrap = h('div', {});
  const draw = async () => {
    const list = await askServer('notes', { action: 'list' });
    if (list.error) return wrap.replaceChildren(h('div', { class: 'card' }, list.error));
    wrap.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('button', { class: 'always', onclick: () => noteDialog({}) }, '+ Note'),
        h('button', { class: 'always', onclick: () => window.open('notes/export.html', '_blank') }, 'Export all (print or save)')),
      list.length ? h('div', { class: 'notes' }, list.slice().reverse().map(n => h('div', { class: 'card note-card' },
        h('div', { class: 'dim' }, `${new Date(n.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${n.cue ? ` · ${n.cue}` : ''}${n.camName ? ` · ${shortName({ name: n.camName })}` : ''}`),
        n.text && h('div', { class: 'ntext' }, n.text),
        n.image && h('img', { src: `notes/img/${n.image}`, class: 'snap', loading: 'lazy' }),
        h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this note?')) await askServer('notes', { action: 'delete', noteId: n.id }); } }, 'Delete'))))
        : h('div', { class: 'card' }, 'No notes yet. Tap 📷 on any camera to grab a picture and add a note, or tap + Note.'));
  };
  (updaters.__notes ||= []).push(draw);
  draw();
  return wrap;
}

// ---------- System tab: TV screens and phone cameras ----------
function screensCard() {
  const cams = cameras().filter(c => c.state.stream);
  const card = h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Camera screens and phone cameras'));
  const keyQ = S.viewKey ? `&key=${S.viewKey}` : '';
  const host = { name: location.hostname };
  const qr = text => h('img', { class: 'qr', src: `api/qr?text=${encodeURIComponent(text)}`, alt: '' });
  const linkBox = (title, url, help) => h('div', { class: 'linkbox' }, qr(url), h('div', {}, h('b', {}, title), h('div', { class: 'mono url' }, url), h('p', { class: 'hint' }, help),
    h('button', { class: 'always', onclick: () => window.open(url, '_blank') }, 'Open')));
  const body = h('div', { class: 'screens' });
  const draw = () => {
    const base = `${location.protocol}//${host.name}${location.port ? `:${location.port}` : ''}`;
    const camId = store.get('tvCam') || cams[0]?.id;
    const sel = h('select', { onchange: e => { store.set('tvCam', e.target.value); draw(); } }, cams.map(c => h('option', { value: c.id, selected: c.id === camId }, c.name)));
    const https = S.video?.httpsPort;
    body.replaceChildren(
      cams.length ? h('div', {}, h('label', { class: 'form' }, 'Camera for the screens', sel),
        linkBox('Backstage TV', `${base}/tv?cam=${camId}&mode=backstage${keyQ}`, 'For dressing rooms and the wings: the camera full screen, with the standby cue and the show clock. Open it in the web browser of a smart TV, or a computer plugged into a TV. It can\'t fire anything.'),
        linkBox('Lobby screen', `${base}/tv?cam=${camId}&mode=lobby${keyQ}`, 'For the foyer: the camera with the show name and the time, without cue details.'))
        : h('p', { class: 'dim' }, 'Add a camera with video to make backstage and lobby screens.'),
      https ? linkBox('Spare phone as a camera', `https://${host.name === 'localhost' ? host.lan || 'localhost' : host.name}:${https}/phone${S.viewKey ? `?key=${S.viewKey}` : ''}`,
        'Scan with the phone\'s camera. The first time, it warns the connection is not private (Show Control made its own certificate): on iPhone tap Show Details, then "visit this website"; on Android tap Advanced, then Proceed. Allow the camera, prop the phone up in the wings, and it appears on the Cameras tab.')
        : h('p', { class: 'dim' }, 'Phone cameras need the secure (HTTPS) address, which is not running.'));
  };
  // The QR codes must point at an address phones can reach, not "localhost".
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') fetch('api/health').then(r => r.json()).then(j => { const u = j.addresses?.[0]?.url; if (u) { host.lan = new URL(u).hostname; host.name = host.lan; draw(); } }).catch(() => {});
  (updaters.__video ||= []).push(draw);
  draw();
  card.append(body);
  return card;
}

// ---------- Lighting tab: focus helper ----------
// Watch the stage on a camera while nudging a moving light from the iPad.
function focusHelper(eos) {
  const cams = cameras();
  const camId = S.devices[store.get('focusCam')] ? store.get('focusCam') : cams[0]?.id;
  const chan = h('input', { inputmode: 'numeric', placeholder: 'Chan', style: 'width:90px', value: store.get('focusChan') || '' });
  chan.addEventListener('change', () => store.set('focusChan', chan.value));
  const fine = h('input', { type: 'checkbox' });
  const c = () => chan.value.trim();
  const sel = op => { if (!c()) return toast('Type a channel number'); cmd(eos.id, 'cmdline', { text: `Chan ${c()}${op ? ` ${op}` : ''}#` }); };
  const wheel = (param, dir) => () => cmd(eos.id, 'wheel', { param, ticks: dir * (fine.checked ? 1 : 4), fine: fine.checked });
  const pad = h('div', { class: 'nudge' },
    h('span'), repeatBtn('▲', wheel('tilt', 1), 150, { class: 'always' }), h('span'),
    repeatBtn('◀', wheel('pan', -1), 150, { class: 'always' }), h('b', { class: 'dim' }, 'Pan / Tilt'), repeatBtn('▶', wheel('pan', 1), 150, { class: 'always' }),
    h('span'), repeatBtn('▼', wheel('tilt', -1), 150, { class: 'always' }), h('span'));
  const pair = (label, param) => h('div', { class: 'row', style: 'align-items:center' }, h('b', { style: 'width:52px' }, label),
    repeatBtn('−', wheel(param, -1)), repeatBtn('+', wheel(param, 1)));
  const camSel = cams.length > 1 && h('select', { onchange: e => { store.set('focusCam', e.target.value); render(); } }, cams.map(x => h('option', { value: x.id, selected: x.id === camId }, x.name)));
  return h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Focus helper', camSel || ''),
    h('div', { class: 'focushelp' },
      camId ? camView(S.devices[camId]) : h('p', { class: 'dim' }, 'Add a camera to watch the stage here.'),
      h('div', {},
        h('div', { class: 'row', style: 'align-items:center' }, chan, h('button', { onclick: () => sel('') }, 'Select'), h('button', { onclick: () => sel('Full') }, 'Full'), h('button', { onclick: () => sel('Out') }, 'Out')),
        h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { onclick: () => cmd(eos.id, 'key', { key: 'last' }) }, '◀ Last'), h('button', { onclick: () => cmd(eos.id, 'key', { key: 'next' }) }, 'Next ▶')),
        pad,
        h('label', { class: 'switch small' }, fine, 'Fine (small steps)'),
        pair('Zoom', 'zoom'), pair('Edge', 'edge'), pair('Iris', 'iris'),
        h('p', { class: 'note' }, 'Nudges use the Eos encoder wheels for the selected channel. Not yet tried on a real console.'))));
}

// ---------- Projection tab: blackout and content check ----------
function blackoutButtons() {
  const restore = h('button', {});
  const draw = sh => { restore.textContent = sh.blackout ? `Restore (${sh.blackout.open.length} open before)` : 'Restore'; restore.disabled = !sh.blackout; };
  restore.onclick = async () => { const r = await askServer('blackout', { on: false }); report(r); };
  const report = r => { if (r.error) return toast(r.error, 5000); const bad = r.filter(x => !GOOD.includes(x.outcome)); if (bad.length) toast(bad.map(x => `${shortName(x)}: ${OUTCOME_WORDS[x.outcome] || x.outcome}`).join('\n'), 6000); };
  (updaters.__show ||= []).push(draw); draw(S.show);
  return [h('button', { class: 'big always', title: 'Works even when the screen is locked', onclick: async () => report(await askServer('blackout', { on: true })) }, 'Black out all'), restore];
}
function contentCheckCard() {
  const out = h('div', { class: 'results' });
  const run = async () => {
    out.textContent = 'Checking… (QLab is asked about every cue, this can take a few seconds)';
    const r = await askServer('content-check', {}, 60000);
    if (r.error) { out.textContent = r.error; return; }
    out.replaceChildren(...r.sections.map(s => h('div', { class: 'checksec' }, h('b', {}, s.title), s.items.map(i => h('div', { class: i.ok ? 'good' : 'bad' }, `${i.ok ? '✓' : '✗'} ${i.text}`)))),
      h('div', { class: 'dim' }, `Checked at ${new Date(r.at).toLocaleTimeString([], { hour12: false })}`));
  };
  return h('div', { class: 'card', style: 'margin-bottom:10px' }, h('h3', {}, 'Content check'),
    h('p', { class: 'hint', style: 'margin-top:0' }, 'Before house open: checks QLab has every audio and video file, that the projectors are on, and that the cameras are connected.'),
    h('button', { class: 'always', onclick: run }, 'Check show content'), out);
}
