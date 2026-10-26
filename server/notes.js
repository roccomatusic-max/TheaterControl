// Rehearsal notes with a camera snapshot: grab a frame on the iPad, add a line of text,
// and it is kept with the time and the cue. Export makes one page with every note and picture.
// Files: <Show Control folder>/Notes/notes.json + one .jpg per snapshot
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class Notes {
  constructor({ dir }) { this.dir = dir; this.file = path.join(dir, 'notes.json'); }

  list() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }

  write(all) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(all, null, 1)); fs.renameSync(`${this.file}.tmp`, this.file);
  }

  // image: a data:image/jpeg;base64,... string from the iPad (optional)
  add({ text = '', image, cam, camName, cue, who }) {
    text = String(text).slice(0, 2000).trim();
    if (!text && !image) throw new Error('The note is empty');
    const note = { id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, at: Date.now(), text, cue: cue || null, cam: cam || null, camName: camName || null, by: who || null };
    if (image) {
      const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!m) throw new Error('That picture could not be read');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8e6) throw new Error('That picture is too big');
      fs.mkdirSync(this.dir, { recursive: true });
      note.image = `${note.id}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      fs.writeFileSync(path.join(this.dir, note.image), buf);
    }
    this.write([...this.list(), note]);
    return note;
  }

  remove(id) {
    const all = this.list(), n = all.find(x => x.id === id);
    if (!n) throw new Error('No such note');
    if (n.image) fs.rmSync(path.join(this.dir, n.image), { force: true });
    this.write(all.filter(x => x.id !== id));
  }

  imagePath(name) {
    if (!/^[a-z0-9]+\.(jpg|png)$/.test(name)) return null;
    const p = path.join(this.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  // One self-contained page (pictures included) to print, save or send to the team.
  exportHtml(showName) {
    const notes = this.list();
    const img = n => { try { return `<img src="data:image/${n.image.endsWith('png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(path.join(this.dir, n.image)).toString('base64')}">`; } catch { return ''; } };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notes · ${esc(showName)}</title><style>
body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:24px auto;max-width:900px;padding:0 16px;color:#111}
h1{margin:0 0 4px}.sub{color:#666;margin:0 0 24px}.n{border-top:1px solid #ddd;padding:14px 0;break-inside:avoid}
.m{color:#666;font-size:13px}.t{font-size:17px;margin:4px 0 8px;white-space:pre-wrap}img{max-width:100%;border-radius:6px}
</style></head><body><h1>Notes · ${esc(showName)}</h1><p class="sub">${notes.length} note${notes.length === 1 ? '' : 's'}, exported ${esc(new Date().toLocaleString())}</p>
${notes.map(n => `<div class="n"><div class="m">${esc(new Date(n.at).toLocaleString())}${n.cue ? ` · ${esc(n.cue)}` : ''}${n.camName ? ` · ${esc(n.camName)}` : ''}</div>
<div class="t">${esc(n.text)}</div>${n.image ? img(n) : ''}</div>`).join('\n')}
</body></html>`;
  }
}

module.exports = Notes;
