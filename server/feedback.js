// Possible-feedback detector, fed with mixer input meters.
// Feedback is a steady tone that stays loud: a channel held above `minDb` for `holdMs` while
// moving less than `steadyDb` is flagged. Singing and speech move around much more than that.
// It is a warning, not proof: a long held note into a hot mic can trip it too.
class FeedbackWatch {
  constructor({ minDb = -12, holdMs = 1000, steadyDb = 3, cooldownMs = 15000 } = {}) {
    Object.assign(this, { minDb, holdMs, steadyDb, cooldownMs });
    this.hist = new Map();   // "device:ch" → [{ t, db }]
    this.quiet = new Map();  // "device:ch" → no new alert before this time
  }

  // levels: dBFS per channel (null = silence). Returns [{ channel, db }] for channels that just tripped.
  push(device, levels, now = Date.now()) {
    const hits = [];
    levels.forEach((db, ch) => {
      const key = `${device}:${ch}`;
      if (db == null || db < this.minDb) { this.hist.delete(key); return; }
      const h = this.hist.get(key) || [];
      h.push({ t: now, db });
      while (h.length && now - h[0].t > this.holdMs * 1.5) h.shift();
      this.hist.set(key, h);
      if (now - h[0].t < this.holdMs || now < (this.quiet.get(key) || 0)) return;
      const dbs = h.map(x => x.db);
      if (Math.max(...dbs) - Math.min(...dbs) <= this.steadyDb) {
        this.quiet.set(key, now + this.cooldownMs);
        hits.push({ channel: ch, db: Math.max(...dbs) });
      }
    });
    return hits;
  }
}

module.exports = FeedbackWatch;
