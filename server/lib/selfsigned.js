// A self-signed HTTPS certificate, made with Node's own crypto (no openssl needed).
// Phones only let a web page use their camera over HTTPS, so the phone-camera page is
// served on a second, HTTPS port. The phone shows a one-time "not private" warning.
const crypto = require('crypto');

// Minimal DER encoding: just the pieces an X.509 certificate needs.
const len = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = s => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a * 40 + b];
  for (const n of rest) { const v = []; let x = n; do { v.unshift(x & 127); x = Math.floor(x / 128); } while (x); out.push(...v.map((d, i) => (i < v.length - 1 ? d | 128 : d))); }
  return tlv(0x06, Buffer.from(out));
};
const int = buf => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = s => tlv(0x0c, Buffer.from(s));
const time = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z')); // UTCTime, fine until 2049
const explicit = (n, ...p) => tlv(0xa0 + n, ...p);

// ips: the addresses phones will use to reach this computer (they go into the certificate).
function make({ name = 'Show Control', ips = [], days = 820 } = {}) {
  // Apple devices refuse server certificates valid for more than 825 days, without a SAN, or without serverAuth.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algo = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const dn = seq(set(seq(oid('2.5.4.3'), utf8(name))));
  const now = Date.now();
  const san = seq(...ips.map(ip => tlv(0x87, Buffer.from(ip.split('.').map(Number)))), tlv(0x82, Buffer.from('localhost')));
  const ext = explicit(3, seq(
    seq(oid('2.5.29.17'), tlv(0x04, san)),                                           // subjectAltName
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),                 // extKeyUsage: serverAuth
    seq(oid('2.5.29.19'), tlv(0x04, seq())),                                         // basicConstraints: not a CA
  ));
  const tbs = seq(explicit(0, int(Buffer.from([2]))), int(crypto.randomBytes(16)), algo, dn,
    seq(time(new Date(now - 86400e3)), time(new Date(now + days * 86400e3))), dn,
    publicKey.export({ type: 'spki', format: 'der' }), ext);
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, algo, tlv(0x03, Buffer.from([0]), sig));
  const pem = (label, b) => `-----BEGIN ${label}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return { cert: pem('CERTIFICATE', der), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// Still usable for these addresses? (Expired or a new address means making a new one.)
function fits(certPem, ips) {
  try {
    const c = new crypto.X509Certificate(certPem);
    if (new Date(c.validTo).getTime() < Date.now() + 7 * 86400e3) return false;
    return ips.every(ip => (c.subjectAltName || '').includes(`IP Address:${ip}`));
  } catch { return false; }
}

module.exports = { make, fits };
