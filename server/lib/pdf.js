// Minimal PDF writer for text reports (no dependencies): pages of Helvetica text, filled
// rectangles and lines. Coordinates are in points from the top-left corner of the page.
// Text is encoded as WinAnsi, so accented Latin letters and common punctuation print; anything
// else becomes "?".
const SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

// Character widths (1/1000 em) of Helvetica and Helvetica-Bold for ASCII 32-126.
const W = {
  regular: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  bold: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const SPECIAL = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const SPECIAL_W = { 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xb7: 278, 0xa0: 278 };
const REPLACE = { '→': '->', '←': '<-', '⚠': '!', '✓': '+', '✗': 'x', '↶': '' };

function encode(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    if (REPLACE[ch] != null) { for (const c of REPLACE[ch]) out.push(c.charCodeAt(0)); continue; }
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (SPECIAL[ch]) out.push(SPECIAL[ch]);
    else if (c === 9 || c === 10) out.push(32);
    else out.push(63);
  }
  return out;
}
const charWidth = (b, bold) => (b >= 32 && b <= 126 ? W[bold ? 'bold' : 'regular'][b - 32] : SPECIAL_W[b] || 556);
const textWidth = (str, size, bold) => encode(str).reduce((n, b) => n + charWidth(b, bold), 0) * size / 1000;
const esc = bytes => bytes.map(b => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : String.fromCharCode(b))).join('');
const rgb = c => { const n = parseInt(String(c || '#000').replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => (v / 255).toFixed(3)).join(' '); };

function create({ size = 'letter' } = {}) {
  const [PW, PH] = SIZES[size] || SIZES.letter;
  const pages = [];
  let ops = null;
  const doc = {
    width: PW, height: PH,
    page() { ops = []; pages.push(ops); return doc; },
    goto(i) { ops = pages[i]; return doc; }, // back to an earlier page (e.g. to add "page 1 of 3")
    text(x, y, str, { size: s = 10, bold = false, color = '#000' } = {}) {
      // y is the top of the line; the baseline sits about 0.8 em below it
      ops.push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${s} Tf 1 0 0 1 ${x.toFixed(2)} ${(PH - y - s * 0.8).toFixed(2)} Tm (${esc(encode(str))}) Tj ET`);
      return doc;
    },
    rect(x, y, w, h, color) { ops.push(`${rgb(color)} rg ${x.toFixed(2)} ${(PH - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); return doc; },
    line(x1, y1, x2, y2, color = '#999', lw = 0.5) { ops.push(`${rgb(color)} RG ${lw} w ${x1.toFixed(2)} ${(PH - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PH - y2).toFixed(2)} l S`); return doc; },
    textWidth,
    // Splits text into lines no wider than w.
    wrap(str, w, s = 10, bold = false) {
      const lines = [];
      for (const para of String(str ?? '').split('\n')) {
        let cur = '';
        for (const word of para.split(/\s+/).filter(Boolean)) {
          const next = cur ? `${cur} ${word}` : word;
          if (textWidth(next, s, bold) <= w) { cur = next; continue; }
          if (cur) lines.push(cur);
          cur = word;
          while (textWidth(cur, s, bold) > w && cur.length > 1) { // a single very long word
            let k = cur.length; while (k > 1 && textWidth(cur.slice(0, k), s, bold) > w) k--;
            lines.push(cur.slice(0, k)); cur = cur.slice(k);
          }
        }
        lines.push(cur);
      }
      return lines;
    },
    get pageCount() { return pages.length; },
    toBuffer() {
      const objs = [];
      const add = body => { objs.push(body); return objs.length; };
      const catalog = add(null), pagesId = add(null);
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = pages.map(p => {
        const content = Buffer.from(p.join('\n'), 'latin1');
        const cid = add({ stream: content });
        return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`);
      });
      objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
      objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
      let pos = chunks[0].length;
      const offsets = [];
      objs.forEach((o, i) => {
        offsets.push(pos);
        const body = o.stream
          ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
          : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
        chunks.push(body); pos += body.length;
      });
      const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
        + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
      chunks.push(Buffer.from(xref, 'latin1'));
      return Buffer.concat(chunks);
    },
  };
  return doc.page();
}

module.exports = { create, textWidth };
