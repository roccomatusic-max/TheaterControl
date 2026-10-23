// Ready-made commands for the "anything" drivers (OSC, TCP/UDP text, HTTP), so that picking
// e.g. "Resolume" from the list gives cue steps like "Trigger clip" instead of raw OSC.
// A template is { label, fields: [[arg, type, default, label]], ...what to send }, with {arg}
// placeholders filled from the cue step's settings.

// "{layer}" → args.layer. Unknown placeholders are left empty.
function fill(str, args = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (args[k] ?? ''));
}

// OSC arguments: numbers stay numbers, "{x}" alone becomes the value of x with its own type.
function fillArgs(list = [], args = {}) {
  return list.map(v => {
    if (typeof v !== 'string') return v;
    const whole = v.match(/^\{(\w+)\}$/);
    if (whole) { const x = args[whole[1]]; return typeof x === 'string' && x.trim() !== '' && !isNaN(x) ? Number(x) : x ?? 0; }
    return fill(v, args);
  });
}

// Text with escapes people can type: \r \n \t and \xHH.
function unescape(s) {
  return String(s).replace(/\\(r|n|t|x([0-9a-fA-F]{2})|\\)/g, (_, c, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : { r: '\r', n: '\n', t: '\t', '\\': '\\' }[c]));
}

// "01 ff 3a" / "01ff3a" → Buffer
function hexBytes(s) {
  const clean = String(s).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex needs an even number of digits');
  return Buffer.from(clean, 'hex');
}

// The cue editor list for a set of templates: { name: fields }
const catalogOf = templates => Object.fromEntries(Object.entries(templates || {}).map(([k, t]) => [k, t.fields || []]));
const labelsOf = templates => Object.fromEntries(Object.entries(templates || {}).map(([k, t]) => [k, t.label || k]));

module.exports = { fill, fillArgs, unescape, hexBytes, catalogOf, labelsOf };
