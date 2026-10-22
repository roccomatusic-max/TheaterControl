// One-command demo: fake devices + server wired to them.  npm run sim
const path = require('path');
require('./devices');
process.argv[2] = path.join(__dirname, '../config/show.sim.json');
setTimeout(() => require('../server/index'), 300);
