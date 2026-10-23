// House lights: the audience lights, from the iPad, a cue or the STOP button. They can live on the
// lighting console (a submaster, some channels, or one macro per look) or on their own DMX box
// (a "DMX over the network" device). Either way they show up as one piece of equipment called
// "House lights" (id "house"), so cues, the rehearsal jump and the second operator treat them
// like anything else. Commands: houseLook { look: full|preshow|half|out, fade } and
// houseLevel { level: 0-100, fade }; fade in seconds, empty for the usual fade.
const fs = require('fs');
const path = require('path');
const Driver = require('../drivers/base');

const LOOKS = [
  { id: 'full', name: 'Full', level: 100 },
  { id: 'preshow', name: 'Preshow', level: 70 },
  { id: 'half', name: 'Half', level: 40 },
  { id: 'out', name: 'Out', level: 0 },
];
const WAYS = { sub: 'eos', chan: 'eos', macro: 'eos', dmx: 'dmx' }; // the kind of equipment each way needs
const STEP_MS = 100; // a submaster fade is sent as small steps

// Eos reads "At 5" as 50%, so levels under 10 need a leading zero.
const eosLevel = pct => (pct >= 100 ? 'Full' : String(Math.round(pct)).padStart(2, '0'));
// "501-504, 510" → "501 Thru 504 + 510"
const eosChans = s => String(s).trim().replace(/\s*(?:-|\bthru\b)\s*/gi, ' Thru ').replace(/\s*[,+]\s*/g, ' + ');

module.exports = function house(ctx) {
  const conf = () => {
    const c = ctx.settings().house || {};
    return { way: '', device: '', sub: 1, chans: '', channels: '', macros: {}, fade: 5, onStop: false, ...c,
      looks: LOOKS.map(l => ({ ...l, level: c.levels?.[l.id] ?? l.level })) };
  };
  const statePath = ctx.STATE_PATH && path.join(path.dirname(ctx.STATE_PATH), `.${path.basename(ctx.SAVE_PATH, '.json')}.house.json`);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }

  let ramp = null, settle = null, watched = null;
  class HouseLights extends Driver {
    constructor() {
      super({ id: 'house', type: 'house', name: 'House lights' });
      this.virtual = true; // not real equipment: the pre-show check and health skip it
      this.state = { level: saved.level ?? null, look: saved.look ?? null, fading: false };
    }
    start() { this.started = true; follow(); }
    stop() { this.started = false; clearInterval(ramp); clearTimeout(settle); follow(); }
    async command(cmd, a = {}) {
      const c = conf();
      if (!c.way || !c.device) throw new Error('The house lights are not set up yet (System → House lights).');
      let level, look = null;
      if (cmd === 'houseLook') {
        const l = c.looks.find(x => x.id === a.look);
        if (!l) throw new Error(`no house light look "${a.look}"`);
        ({ level } = l); look = l.id;
      } else if (cmd === 'houseLevel') level = Math.max(0, Math.min(100, Math.round(Number(a.level))));
      else return super.command(cmd);
      if (!Number.isFinite(level)) throw new Error('Which level?');
      const fade = a.fade === '' || a.fade == null ? Number(c.fade) || 0 : Math.max(0, Math.min(600, Number(a.fade) || 0));
      const under = ctx.devices.get(c.device);
      if (!under) return { outcome: 'not_sent', detail: `${c.device} is not in the equipment list` };
      if (!['online', 'sim'].includes(under.status)) return { outcome: 'not_sent', detail: `${under.name} is not connected` };
      return go(c, under, level, look, fade);
    }
  }
  const dev = new HouseLights();
  dev.on('log', ctx.log);
  let lastSent = 0, queued = null;
  dev.on('changed', () => {
    // a fade changes the level ten times a second; screens hear about it four times a second
    clearTimeout(queued);
    const wait = 250 - (Date.now() - lastSent);
    queued = setTimeout(() => { lastSent = Date.now(); if (ctx.devices.get('house') === dev) ctx.broadcast({ t: 'device', device: dev.snapshot() }); }, Math.max(0, wait));
  });

  const remember = () => { if (statePath) try { ctx.writeJson(statePath, { level: dev.state.level, look: dev.state.look }); } catch { /* not critical */ } };
  async function go(c, under, level, look, fade) {
    clearInterval(ramp); clearTimeout(settle);
    const from = dev.state.level ?? (level > 0 ? 0 : 100);
    const done = () => { dev.patch({ level, fading: false }); remember(); };
    dev.patch({ look, target: level, fading: fade > 0, ...(c.way === 'sub' ? {} : { level }) });
    if (!fade) done(); else if (c.way !== 'sub') settle = setTimeout(done, fade * 1000);
    switch (c.way) {
      case 'sub': {
        const set = pct => under.command('sub', { sub: c.sub, level: Math.round(pct) / 100 });
        if (!fade) { await set(level); return { outcome: 'sent' }; }
        const start = Date.now();
        await set(from);
        ramp = setInterval(() => {
          const k = Math.min(1, (Date.now() - start) / (fade * 1000));
          const now = from + (level - from) * k;
          set(now);
          if (k >= 1) { clearInterval(ramp); done(); } else dev.patch({ level: Math.round(now) });
        }, STEP_MS);
        return { outcome: 'sent', detail: `fading over ${fade} s` };
      }
      case 'chan':
        await under.command('cmdline', { text: `Chan ${eosChans(c.chans)} At ${eosLevel(level)}${fade ? ` Time ${fade}` : ''}#` });
        return { outcome: 'sent' };
      case 'macro': {
        // one macro per look: a level in between uses the nearest look that has a macro
        const l = look ? c.looks.find(x => x.id === look) : c.looks.filter(x => c.macros[x.id]).sort((p, q) => Math.abs(p.level - level) - Math.abs(q.level - level))[0];
        const macro = l && c.macros[l.id];
        if (!macro) return { outcome: 'not_sent', detail: `no Eos macro for ${l?.name || 'that level'} (System → House lights)` };
        if (!look) dev.patch({ look: l.id, target: l.level, level: l.level });
        await under.command('macro', { macro });
        return { outcome: 'sent', detail: `macro ${macro}` };
      }
      case 'dmx': {
        const r = await under.command('level', { channels: c.channels, level, fade });
        return r && typeof r === 'object' ? r : { outcome: 'sent' };
      }
      default: return { outcome: 'not_sent', detail: 'unknown way to run the house lights' };
    }
  }

  // The House lights look as connected as the equipment they run on.
  function follow() {
    const c = conf();
    const under = c.device && ctx.devices.get(c.device);
    if (watched !== under) {
      watched?.off('changed', mirror);
      watched = under || null;
      watched?.on('changed', mirror);
    }
    mirror();
  }
  function mirror() {
    const st = !dev.started ? 'offline' : watched ? watched.status : 'offline';
    if (st !== dev.status) { dev.status = st; dev.changed(); }
  }
  // Registered as equipment only while it is set up.
  function register(publish) {
    const on = !!(conf().way && conf().device);
    if (on && !ctx.devices.has('house')) ctx.devices.set('house', dev);
    if (!on && ctx.devices.get('house') === dev) ctx.devices.delete('house');
    if (ctx.devicesStarted && on && !dev.started) dev.start();
    follow();
    if (publish) ctx.broadcast({ t: 'house', house: on ? dev.snapshot() : null });
  }
  register(false); // at start-up, before any screen is connected

  // ---------- settings ----------
  const choices = () => ctx.cfg.devices.filter(d => Object.values(WAYS).includes(d.type)).map(d => ({ id: d.id, name: d.name || d.id, type: d.type }));
  const info = () => {
    const { way, device, sub, chans, channels, macros, fade, onStop, looks } = conf();
    return { way, device, sub, chans, channels, macros, fade, onStop, looks, choices: choices(), state: ctx.devices.has('house') ? dev.snapshot() : null };
  };
  ctx.handlers['house-get'] = () => info();
  ctx.handlers['house-set'] = (m, ws) => {
    const cur = ctx.settings().house || {};
    const next = { ...cur };
    if ('way' in m) {
      if (m.way && !WAYS[m.way]) throw new Error('Pick how the house lights are run.');
      next.way = m.way || '';
    }
    if ('device' in m) next.device = String(m.device || '');
    if (next.way && next.device) {
      const dc = ctx.cfg.devices.find(d => d.id === next.device);
      if (!dc) throw new Error('Pick the equipment the house lights are on.');
      if (dc.type !== WAYS[next.way]) next.device = choices().find(d => d.type === WAYS[next.way])?.id || '';
    }
    if ('sub' in m) { const n = Number(m.sub); if (!(Number.isInteger(n) && n >= 1 && n <= 999)) throw new Error('A submaster number is 1 to 999.'); next.sub = n; }
    if ('chans' in m) {
      const s = String(m.chans || '').trim();
      if (s && !/^\d+(\s*(-|thru|,|\+)\s*\d+)*$/i.test(s)) throw new Error('Type channels like 501-504 or 501, 502, 510.');
      next.chans = s;
    }
    if ('channels' in m) {
      const s = String(m.channels || '').trim();
      if (s && (!/^\d+(\s*(-|,)\s*\d+)*$/.test(s) || s.match(/\d+/g).some(n => n < 1 || n > 512))) throw new Error('Type DMX channels (1-512) like 1-4 or 1, 2, 9.');
      next.channels = s;
    }
    if (m.macros) {
      next.macros = { ...(cur.macros || {}) };
      for (const [k, v] of Object.entries(m.macros)) {
        if (!LOOKS.some(l => l.id === k)) continue;
        if (v === '' || v == null) { delete next.macros[k]; continue; }
        const n = Number(v);
        if (!(Number.isInteger(n) && n >= 1 && n <= 99999)) throw new Error('A macro number is a whole number.');
        next.macros[k] = n;
      }
    }
    if (m.levels) {
      next.levels = { ...(cur.levels || {}) };
      for (const [k, v] of Object.entries(m.levels)) {
        const n = Number(v);
        if (LOOKS.some(l => l.id === k) && Number.isFinite(n)) next.levels[k] = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    if ('fade' in m) next.fade = Math.max(0, Math.min(60, Number(m.fade) || 0));
    if ('onStop' in m) next.onStop = !!m.onStop;
    ctx.saveSettings({ house: next });
    ctx.log({ device: 'house', level: 'cmd', msg: `house lights set up changed by ${ws.who}`, t: Date.now() });
    register(true);
    return info();
  };
  ctx.access?.viewerMay('house-get');
  ctx.access?.adminOnly('house-set');

  // Holding STOP brings the house lights up, when that's switched on.
  ctx.events.on('emergency', who => {
    if (!conf().onStop || !ctx.devices.has('house')) return;
    ctx.runAction({ device: 'house', cmd: 'houseLook', args: { look: 'full', fade: 2 } }, `EMERGENCY ${who}`).catch(() => {});
  });

  ctx.checks.push(() => {
    if (!ctx.devices.has('house')) return [];
    const c = conf(), under = ctx.devices.get(c.device);
    const where = { sub: `submaster ${c.sub} on ${under?.name}`, chan: `channels ${c.chans} on ${under?.name}`, macro: `macros on ${under?.name}`, dmx: `${under?.name}` }[c.way];
    const ok = under && ['online', 'sim'].includes(under.status);
    const now = dev.state.level == null ? '' : ` Now at ${c.looks.find(l => l.id === dev.state.look && l.level === dev.state.level)?.name || `${dev.state.level}%`}.`;
    return [{ group: 'Equipment', label: 'House lights', state: ok ? 'ok' : 'error', detail: `${ok ? 'Ready' : 'Not connected'}: ${where}.${now}${c.onStop ? ' STOP brings them to Full.' : ''}` }];
  });
  ctx.initExtras.push(() => ({ house: ctx.devices.has('house') ? info() : null }));
  ctx.house = { LOOKS, look: id => conf().looks.find(l => l.id === id) };
};
