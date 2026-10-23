// Which show file the launcher runs, and in which mode:
//  - practice: pretend equipment, with the practice copy of the show (or the sample show);
//  - live: the real show file, ~/Show Control/show.json, made by the Setup screen ("live": false
//    in it means back to practice). The server itself may then start in training mode instead
//    (System > Training, see the top of server/index.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIM_CFG = path.join(__dirname, '..', 'config', 'show.sim.json');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function paths(home = os.homedir()) {
  const dir = path.join(home, 'Show Control');
  return { dir, real: path.join(dir, 'show.json'), practice: path.join(dir, 'practice-show.json'), sim: SIM_CFG };
}

function plan(home) {
  const p = paths(home);
  const real = read(p.real);
  if (real && real.live !== false) return { mode: 'live', cfgPath: p.real, save: p.real, sims: false, p };
  return { mode: 'practice', cfgPath: fs.existsSync(p.practice) ? p.practice : SIM_CFG, save: p.practice, sims: true, p, broken: fs.existsSync(p.real) && !real };
}

// What the server is told about the plan (see the top of server/index.js).
const env = pl => ({
  SHOW_MODE: pl.mode, SHOW_SAVE_PATH: pl.save, SHOW_LIVE_PATH: pl.p.real, SHOW_PRACTICE_PATH: pl.p.practice,
  SHOW_SIM_CONFIG: SIM_CFG, SHOW_SIMS: pl.sims ? '1' : '',
});

module.exports = { paths, plan, env, read };
