// "Start Show Control when this computer turns on", for the always-on show computer.
// Mac: a LaunchAgent (runs when the user logs in; turn on automatic login for a server).
// Windows: a shortcut script in the Startup folder. Linux desktop: an autostart entry.
const fs = require('fs');
const os = require('os');
const path = require('path');

const START = path.join(__dirname, 'start.js');
const LABEL = 'com.showcontrol.app';
const LOG = path.join(os.homedir(), 'Show Control', 'show-control.log');

function file() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Show Control.bat');
  return path.join(os.homedir(), '.config', 'autostart', 'show-control.desktop');
}
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function contents() {
  const node = process.execPath;
  if (process.platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(START)}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`;
  if (process.platform === 'win32') return `@echo off\r\nstart "Show Control" /min "${node}" "${START}" --background\r\n`;
  return `[Desktop Entry]\nType=Application\nName=Show Control\nExec="${node}" "${START}" --background\nX-GNOME-Autostart-enabled=true\n`;
}

// on: true/false. Returns the new status. The app must stay in the same folder afterwards.
function set(on) {
  const f = file();
  if (on) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(f, contents()); }
  else fs.rmSync(f, { force: true });
  return status();
}
function status() {
  const f = file();
  const on = fs.existsSync(f);
  // Pointing at a different copy of the app (moved or updated folder) counts as off, so turning it on again fixes it.
  return { on: on && fs.readFileSync(f, 'utf8').includes(START), platform: process.platform, folder: path.resolve(__dirname, '..', '..') };
}

module.exports = { set, status };
