// Unpacks a .zip file: the Mac and Windows downloads, for the one-tap update (features/updates.js).
// Stored and deflated entries, folders, file permissions (so the bundled node can run) and symbolic
// links inside the folder (skipped on Windows, where the ones in the download aren't needed).
// No ZIP64: the downloads are far smaller than 4 GB.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const inflate = promisify(zlib.inflateRaw);

async function unzip(file, dest) {
  const buf = await fs.promises.readFile(file);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('This is not a zip file.');
  const count = buf.readUInt16LE(end + 10), dirAt = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirAt === 0xffffffff) throw new Error('This zip file is in a format Show Control can\'t open (ZIP64).');
  const root = path.resolve(dest);
  const inside = p => p === root || p.startsWith(root + path.sep);
  fs.mkdirSync(root, { recursive: true });
  let p = dirAt, files = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const madeBy = buf.readUInt16LE(p + 4) >> 8, method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const target = path.resolve(root, name);
    if (!inside(target)) throw new Error(`The zip file has a file outside its folder (${name}).`);
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('The zip file is damaged.');
    const at = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(at, at + csize);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
    if (!data) throw new Error(`The zip file uses a kind of compression Show Control can't open (${method}).`);
    if (data.length !== usize || (zlib.crc32 && zlib.crc32(data) !== crc)) throw new Error(`The zip file is damaged (${name}).`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = madeBy === 3 ? attrs >>> 16 : 0; // made on Mac/Linux: Unix permissions and file type
    if ((mode & 0o170000) === 0o120000) {
      const to = data.toString('utf8');
      if (process.platform === 'win32' || !inside(path.resolve(path.dirname(target), to))) continue;
      fs.rmSync(target, { force: true });
      fs.symlinkSync(to, target);
      continue;
    }
    fs.writeFileSync(target, data);
    if (mode & 0o777 && process.platform !== 'win32') fs.chmodSync(target, mode & 0o777);
    files++;
  }
  return files;
}

module.exports = unzip;
