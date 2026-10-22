// Child process started by launcher/start.js: one run of the Show Control server.
// Exits with code 75 when the Setup screen asks for a restart (e.g. practice → live).
if (process.env.SHOW_SIMS) require('../sim/devices');
setTimeout(() => {
  const { server } = require('../server/index');
  server.on('ready', ({ urls }) => process.send?.({ t: 'ready', urls }));
  server.on('error', e => { console.error(`\n  Could not start: ${e.message}\n`); process.exit(1); });
}, process.env.SHOW_SIMS ? 300 : 0);
