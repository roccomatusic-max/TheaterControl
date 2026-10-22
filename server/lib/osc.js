// Minimal OSC 1.0 encoder/decoder (strings, int32, float32, blobs) plus SLIP framing for OSC-over-TCP.

function pad4(n) { return (4 - (n % 4)) % 4; }

function encString(s) {
  const b = Buffer.from(s + '\0', 'utf8');
  return Buffer.concat([b, Buffer.alloc(pad4(b.length))]);
}

function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'number') {
      if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b); }
      else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); }
    } else if (typeof a === 'string') { tags += 's'; parts.push(encString(a)); }
    else if (a && a.type === 'f') { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a.value); parts.push(b); }
    else if (a && a.type === 'i') { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a.value); parts.push(b); }
    else if (a === true) tags += 'T';
    else if (a === false) tags += 'F';
    else if (Buffer.isBuffer(a)) {
      tags += 'b'; const len = Buffer.alloc(4); len.writeInt32BE(a.length);
      parts.push(len, a, Buffer.alloc(pad4(a.length)));
    }
  }
  return Buffer.concat([encString(address), encString(tags), ...parts]);
}

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('utf8', off, end);
  end++;
  return [s, end + pad4(end - off)];
}

function decode(buf) {
  if (buf.toString('utf8', 0, 7) === '#bundle') {
    const msgs = [];
    let off = 16;
    while (off < buf.length) {
      const size = buf.readInt32BE(off); off += 4;
      msgs.push(...[].concat(decode(buf.subarray(off, off + size))));
      off += size;
    }
    return msgs;
  }
  let [address, off] = readString(buf, 0);
  let tags = ',';
  if (off < buf.length) [tags, off] = readString(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 's') { let s; [s, off] = readString(buf, off); args.push(s); }
    else if (t === 'b') { const n = buf.readInt32BE(off); off += 4; args.push(buf.subarray(off, off + n)); off += n + pad4(n); }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N') args.push(null);
  }
  return { address, args };
}

// SLIP (RFC 1055) framing used by OSC 1.1 over TCP (Eos port 3037)
const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;
function slipEncode(buf) {
  const out = [END];
  for (const b of buf) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return Buffer.from(out);
}
class SlipDecoder {
  constructor(onPacket) { this.onPacket = onPacket; this.cur = []; this.esc = false; }
  push(chunk) {
    for (const b of chunk) {
      if (this.esc) { this.cur.push(b === ESC_END ? END : b === ESC_ESC ? ESC : b); this.esc = false; }
      else if (b === ESC) this.esc = true;
      else if (b === END) { if (this.cur.length) this.onPacket(Buffer.from(this.cur)); this.cur = []; }
      else this.cur.push(b);
    }
  }
}

module.exports = { encode, decode, slipEncode, SlipDecoder };
