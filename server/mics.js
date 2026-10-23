// The mic plot: radio mic packs, who wears them, and which are live in each scene.
// Shows up as the "mics" device, so a show cue can switch the mics for a scene:
//   { "device": "mics", "cmd": "scene", "args": { "scene": "1-2" } }
// That turns each pack's mixer channel on or off to match the scene. Pack status (battery,
// signal, whether the desk has the channel on) comes from the receivers and the mixer.
//
// config "mics": {
//   "packs":  [ { "id": "1", "name": "Pack 1", "actor": "Sam", "mixer": "tf5", "channel": 0, "receiver": "rx1", "rxChannel": 1 } ],
//   "scenes": [ { "id": "1-2", "name": "1-2 Duet", "live": ["1", "2"], "wearers": { "2": "Jo (cover)" } } ],
//   "lowBatteryBars": 1
// }
const Driver = require('./drivers/base');

const ID = /^[A-Za-z0-9_.-]{1,24}$/;

class MicPlan extends Driver {
  constructor(mics, devices) {
    super({ id: 'mics', type: 'mics', name: 'Mics' });
    this.devices = devices;
    this.low = new Set(); // packs already warned about a low battery
    this.load(mics);
  }

  load(mics = {}) {
    this.plan = { packs: mics.packs || [], scenes: mics.scenes || [], lowBatteryBars: mics.lowBatteryBars ?? 1 };
    this.state = { ...this.plan, current: this.state?.current ?? null, status: {} };
    this.refresh(true);
  }

  start() { this.setStatus('online'); }

  mixerFor(p) { return this.devices.get(p.mixer) || [...this.devices.values()].find(d => d.type === 'yamaha-tf'); }

  // Live status of every pack, recomputed whenever a mixer or receiver changes.
  refresh(force) {
    const status = {}, alerts = [];
    for (const p of this.plan.packs) {
      const mixer = this.mixerFor(p), strip = mixer?.state.channels?.[p.channel];
      const rx = this.devices.get(p.receiver), rc = rx?.state.channels?.[(p.rxChannel || 1) - 1];
      const s = {
        mixer: mixer?.id || null, mixerOnline: mixer?.status === 'online', on: strip ? strip.on : null, channelName: strip?.name || null,
        receiverOnline: rx ? rx.status === 'online' : null, tx: rc ? rc.tx : null,
        batteryBars: rc?.batteryBars ?? null, batteryMinutes: rc?.batteryMinutes ?? null, batteryPercent: rc?.batteryPercent ?? null, rf: rc?.rf ?? null,
      };
      s.lowBattery = s.batteryBars != null && s.batteryBars <= this.plan.lowBatteryBars;
      status[p.id] = s;
      if (s.lowBattery && !this.low.has(p.id)) { this.low.add(p.id); alerts.push(p); }
      if (!s.lowBattery && (s.batteryBars ?? 0) > this.plan.lowBatteryBars) this.low.delete(p.id); // new battery in
    }
    const changed = force || JSON.stringify(status) !== JSON.stringify(this.state.status);
    this.state.status = status;
    for (const p of alerts) {
      const s = status[p.id], who = this.wearer(p);
      this.emit('alert', { key: `batt:${p.id}`, kind: 'battery', title: `Low battery: ${p.name}${who ? ` (${who})` : ''}`,
        detail: `${s.batteryBars} bar${s.batteryBars === 1 ? '' : 's'} left${s.batteryMinutes != null ? `, about ${fmtMinutes(s.batteryMinutes)}` : ''}` });
    }
    if (changed) this.changed();
  }

  // Who wears a pack in the current scene (a scene can name a different wearer, e.g. a cover).
  wearer(p, sceneId = this.state.current) {
    const sc = this.plan.scenes.find(s => s.id === sceneId);
    return sc?.wearers?.[p.id] || p.actor || '';
  }

  async command(cmd, a = {}) {
    if (cmd === 'scene') return this.applyScene(String(a.scene));
    if (cmd === 'pack') { // one pack on or off: { pack, on }
      const p = this.plan.packs.find(x => x.id === String(a.pack));
      if (!p) return { outcome: 'not_sent', detail: `no pack "${a.pack}"` };
      return this.setPack(p, !!a.on);
    }
    return super.command(cmd);
  }

  async setPack(p, on) {
    const mixer = this.mixerFor(p);
    if (!mixer || p.channel == null) return { outcome: 'not_sent', detail: `${p.name} has no mixer channel` };
    if (mixer.status !== 'online') return { outcome: 'offline', detail: `${mixer.name} not connected` };
    await mixer.command('on', { strip: 'ch', index: p.channel, on });
    return { outcome: 'sent' };
  }

  async applyScene(id) {
    const sc = this.plan.scenes.find(s => s.id === id);
    if (!sc) return { outcome: 'not_sent', detail: `no mic scene "${id}"` };
    const live = new Set(sc.live || []);
    const res = await Promise.all(this.plan.packs.filter(p => p.channel != null).map(p => this.setPack(p, live.has(p.id)).then(r => ({ p, r }))));
    this.state.current = id;
    this.changed();
    const bad = res.filter(x => x.r.outcome !== 'sent');
    if (bad.length === res.length && res.length) return { outcome: bad[0].r.outcome, detail: bad[0].r.detail };
    return { outcome: bad.length ? 'not_sent' : 'sent', detail: `${sc.name}: ${[...live].length} live${bad.length ? `; not switched: ${bad.map(x => x.p.name).join(', ')}` : ''}` };
  }
}

const fmtMinutes = m => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

// What the iPad may save as the mic plot. Bad ids, duplicate ids and unknown equipment are refused.
function validateMics(m, knownDevice) {
  if (!m || !Array.isArray(m.packs) || !Array.isArray(m.scenes)) throw new Error('mic plot must have packs and scenes');
  const ids = new Set();
  const packs = m.packs.map((p, i) => {
    const id = String(p.id ?? '').trim(), where = `pack ${i + 1}`;
    if (!ID.test(id)) throw new Error(`${where}: bad id`);
    if (ids.has(id)) throw new Error(`two packs are both "${id}"`);
    ids.add(id);
    const out = { id, name: String(p.name || '').trim() || `Pack ${id}`, actor: String(p.actor || '').trim() };
    if (p.mixer) { if (!knownDevice(p.mixer)) throw new Error(`${out.name}: unknown mixer "${p.mixer}"`); out.mixer = p.mixer; }
    if (p.channel !== '' && p.channel != null) {
      const ch = Number(p.channel);
      if (!Number.isInteger(ch) || ch < 0 || ch > 63) throw new Error(`${out.name}: mixer channel must be 1-64`);
      out.channel = ch;
    }
    if (p.receiver) {
      if (!knownDevice(p.receiver)) throw new Error(`${out.name}: unknown receiver "${p.receiver}"`);
      const rc = Number(p.rxChannel || 1);
      if (!Number.isInteger(rc) || rc < 1 || rc > 8) throw new Error(`${out.name}: receiver channel must be 1-8`);
      Object.assign(out, { receiver: p.receiver, rxChannel: rc });
    }
    return out;
  });
  const sids = new Set();
  const scenes = m.scenes.map((s, i) => {
    const id = String(s.id ?? '').trim();
    if (!ID.test(id)) throw new Error(`scene ${i + 1}: bad id`);
    if (sids.has(id)) throw new Error(`two scenes are both "${id}"`);
    sids.add(id);
    const wearers = Object.fromEntries(Object.entries(s.wearers || {}).map(([k, v]) => [k, String(v).trim()]).filter(([k, v]) => ids.has(k) && v));
    return { id, name: String(s.name || '').trim() || `Scene ${i + 1}`, live: [...new Set((s.live || []).map(String))].filter(x => ids.has(x)), ...(Object.keys(wearers).length ? { wearers } : {}) };
  });
  const low = Number(m.lowBatteryBars ?? 1);
  return { packs, scenes, lowBatteryBars: Number.isInteger(low) && low >= 0 && low <= 4 ? low : 1 };
}

module.exports = { MicPlan, validateMics };
