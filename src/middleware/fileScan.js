'use strict';
// Checks uploaded files before they're stored (uploads are held in memory by
// multer). Two layers:
//   1. Content check, always on: the file's first bytes must match the type it
//      claims (a renamed .exe sent as "image/jpeg" is rejected), and PDFs that
//      embed JavaScript or auto-launch actions are rejected.
//   2. Antivirus, when CLAMAV_HOST is set: the file is streamed to a ClamAV
//      daemon (clamd INSTREAM). Without it, only layer 1 runs.
const net = require('net');

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];   // legacy .doc/.xls

const SIGNATURES = {
  'image/jpeg': b => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/jpg': b => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': b => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/webp': b => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  'image/tiff': b => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  'application/pdf': b => b.slice(0, 1024).includes('%PDF-'),
  'application/msword': b => startsWith(b, OLE),
  'application/vnd.ms-excel': b => startsWith(b, OLE),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': b => startsWith(b, ZIP),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': b => startsWith(b, ZIP),
};
const TEXT_TYPES = ['text/plain', 'text/csv', 'application/csv'];
const EXECUTABLE = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe], [0x23, 0x21]]; // PE, ELF, Mach-O, #! script

function contentProblem(file) {
  const b = file.buffer;
  if (!b || !b.length) return 'The file is empty';
  if (EXECUTABLE.some(sig => startsWith(b, sig))) return 'Executable files are not allowed';
  if (TEXT_TYPES.includes(file.mimetype)) {
    return b.slice(0, 8192).includes(0) ? 'This does not look like a text file' : null;
  }
  const check = SIGNATURES[file.mimetype];
  if (check && !check(b)) return `The file's contents don't match its type (${file.mimetype})`;
  if (file.mimetype === 'application/pdf') {
    // Look only at the PDF's object dictionaries: binary stream data can
    // contain "/JS" by chance and would cause false rejections.
    const s = b.toString('latin1').replace(/stream\r?\n[\s\S]*?endstream/g, '');
    if (/\/(JavaScript|JS|Launch)\b/.test(s)) return 'PDFs with embedded scripts or launch actions are not allowed';
  }
  if (ZIP.every((x, i) => b[i] === x) && b.includes('vbaProject.bin')) return 'Office files with macros are not allowed';
  return null;
}

/** clamd INSTREAM. Resolves 'OK', 'FOUND <name>', or rejects on connection errors. */
function clamScan(buffer, host, port = 3310, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let reply = '';
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('ClamAV timed out')); });
    sock.on('error', reject);
    sock.on('data', d => { reply += d.toString(); });
    sock.on('end', () => resolve(reply.replace(/\0/g, '').trim()));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += 64 * 1024) {
        const chunk = buffer.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.alloc(4));
    });
  });
}

async function scanFile(file) {
  const problem = contentProblem(file);
  if (problem) return { ok: false, reason: problem };
  const host = process.env.CLAMAV_HOST;
  if (!host) return { ok: true, scanned: false };
  try {
    const reply = await clamScan(file.buffer, host, Number(process.env.CLAMAV_PORT || 3310));
    if (/FOUND/.test(reply)) return { ok: false, reason: `Virus detected: ${reply.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '')}` };
    return { ok: true, scanned: true };
  } catch (err) {
    // Fail closed only if the operator asked for it; otherwise log and allow.
    console.error('[fileScan] ClamAV unavailable:', err.message);
    if (process.env.CLAMAV_REQUIRED === 'true') return { ok: false, reason: 'Virus scanner unavailable — try again later' };
    return { ok: true, scanned: false };
  }
}

/** Express middleware: run after multer; rejects the request if any file fails. */
async function scanUploads(req, res, next) {
  try {
    const files = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())].filter(Boolean);
    for (const f of files) {
      const r = await scanFile(f);
      if (!r.ok) return res.status(422).json({ error: `${f.originalname}: ${r.reason}` });
    }
    next();
  } catch (err) { next(err); }
}

module.exports = { scanUploads, scanFile, contentProblem, clamScan };
