// Server-side upload inspection. The browser's file name, MIME type, extension and size are never trusted:
// the allow-list is applied to the real bytes, and the stored object gets a random name and the detected extension.
import zlib from "node:zlib";
import crypto from "node:crypto";
import { HttpError, safeFilename } from "./validate.js";

export const ALLOWED_TYPES = {
  pdf: { ext: "pdf", mime: "application/pdf", declared: ["application/pdf"] },
  png: { ext: "png", mime: "image/png", declared: ["image/png"] },
  jpeg: { ext: "jpg", mime: "image/jpeg", declared: ["image/jpeg", "image/jpg", "image/pjpeg"] },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", declared: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
};
const EXT_TO_TYPE = { pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", docx: "docx" };
const MAX_PIXELS = 100_000_000;
const reject = (message, status = 415) => new HttpError(status, message, "UPLOAD_REJECTED");

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

function sniff(buf) {
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 8 && startsWith(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return "png";
  if (buf.length >= 4 && startsWith(buf, [0xFF, 0xD8, 0xFF])) return "jpeg";
  if (buf.length >= 4 && startsWith(buf, [0x50, 0x4B, 0x03, 0x04])) return "docx"; // ZIP container; verified below
  return null;
}

function inspectPdf(buf) {
  const tail = buf.toString("latin1", Math.max(0, buf.length - 2048));
  if (!tail.includes("%%EOF")) throw reject("This PDF looks damaged or incomplete.", 400);
  // Names such as /J#61vaScript are decoded before matching so obfuscation does not hide active content.
  const text = buf.toString("latin1").replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA|SubmitForm|ImportData)\b/.test(text)) {
    throw reject("PDFs with scripts, launch actions or embedded files are not allowed.");
  }
}
function inspectPng(buf) {
  let off = 8, first = true, ended = false, width = 0, height = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (len > buf.length - off - 12) throw reject("This PNG looks damaged.", 400);
    if (first) {
      if (type !== "IHDR" || len !== 13) throw reject("This PNG looks damaged.", 400);
      width = buf.readUInt32BE(off + 8); height = buf.readUInt32BE(off + 12); first = false;
    }
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) throw reject("This PNG looks damaged.", 400);
    off += 12 + len;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended || off !== buf.length) throw reject("This image has extra hidden data or is damaged.");
  if (!width || !height || width * height > MAX_PIXELS) throw reject("This image is too large in pixels.", 413);
}
function inspectJpeg(buf) {
  let off = 2, width = 0, height = 0;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xFF) throw reject("This JPEG looks damaged.", 400);
    while (buf[off + 1] === 0xFF) off++;
    const marker = buf[off + 1];
    if (marker === 0xDA) break;
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) throw reject("This JPEG looks damaged.", 400);
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) { height = buf.readUInt16BE(off + 5); width = buf.readUInt16BE(off + 7); break; }
    off += 2 + len;
  }
  if (!width || !height || width * height > MAX_PIXELS) throw reject("This JPEG looks damaged or is too large.", 400);
  let end = buf.length;
  while (end > 2 && buf[end - 1] === 0x00) end--;
  if (buf[end - 2] !== 0xFF || buf[end - 1] !== 0xD9) throw reject("This JPEG looks damaged or incomplete.", 400);
}
function scanForEmbeddedCode(buf) {
  const text = buf.toString("latin1").toLowerCase();
  if (/<script|<\?php|<html|<iframe|javascript:/.test(text)) throw reject("This image contains hidden code and was blocked.");
}

const BLOCKED_ENTRY = /\.(exe|dll|js|vbs|bat|cmd|ps1|jar|html?|hta|scr|com|msi|lnk|sh|php|swf)$/i;
function inspectDocx(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw reject("This Word file looks damaged.", 400);
  const total = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) throw reject("ZIP64 Word files are not supported.");
  if (total > 2000 || cdOffset + cdSize > buf.length) throw reject("This Word file is not valid.", 400);
  const entries = new Map();
  let off = cdOffset, uncompressedTotal = 0;
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw reject("This Word file is not valid.", 400);
    const method = buf.readUInt16LE(off + 10), comp = buf.readUInt32LE(off + 20), uncomp = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (comp === 0xFFFFFFFF || uncomp === 0xFFFFFFFF) throw reject("ZIP64 Word files are not supported.");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw reject("This Word file has unsafe contents.");
    if (BLOCKED_ENTRY.test(name) || /vbaproject\.bin$/i.test(name) || /^word\/(embeddings|activeX)\//i.test(name)) throw reject("Word files with macros, embedded objects or programs are not allowed.");
    if (uncomp > 1_048_576 && uncomp / Math.max(comp, 1) > 200) throw reject("This Word file is suspiciously compressed.");
    uncompressedTotal += uncomp;
    entries.set(name, { method, comp, uncomp, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (uncompressedTotal > 200 * 1024 * 1024) throw reject("This Word file expands to too much data.", 413);
  if (!entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) throw reject("This is not a valid Word (.docx) document.");
  const ct = entries.get("[Content_Types].xml");
  if (ct.local + 30 > buf.length || buf.readUInt32LE(ct.local) !== 0x04034b50) throw reject("This Word file is not valid.", 400);
  const dataStart = ct.local + 30 + buf.readUInt16LE(ct.local + 26) + buf.readUInt16LE(ct.local + 28);
  const raw = buf.subarray(dataStart, dataStart + ct.comp);
  let xml;
  try { xml = (ct.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 1_048_576 })).toString("utf8"); }
  catch { throw reject("This Word file is not valid.", 400); }
  if (/macroEnabled|vbaProject/i.test(xml)) throw reject("Word files with macros are not allowed.");
}

// Returns { type, ext, mime, displayName, size } or throws an HttpError the client can show.
export function inspectUpload({ buffer, originalName, declaredMime, maxBytes }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw reject("The file is empty.", 400);
  if (buffer.length > maxBytes) throw reject(`Files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`, 413);
  const nameExt = String(originalName || "").split(".").pop().toLowerCase();
  if (!originalName || !EXT_TO_TYPE[nameExt]) throw reject("Only PDF, JPG, PNG and DOCX files can be uploaded.");
  const type = sniff(buffer);
  if (!type || type !== EXT_TO_TYPE[nameExt]) throw reject("The file's content does not match its extension, so it was blocked.");
  const declared = String(declaredMime || "").toLowerCase().split(";")[0].trim();
  if (declared && declared !== "application/octet-stream" && !ALLOWED_TYPES[type].declared.includes(declared)) throw reject("The file's declared type does not match its content, so it was blocked.");
  if (type === "pdf") inspectPdf(buffer);
  else if (type === "png") { inspectPng(buffer); scanForEmbeddedCode(buffer); }
  else if (type === "jpeg") { inspectJpeg(buffer); scanForEmbeddedCode(buffer); }
  else inspectDocx(buffer);
  const info = ALLOWED_TYPES[type];
  return { type, ext: info.ext, mime: info.mime, displayName: safeFilename(originalName, info.ext), size: buffer.length };
}

// Storage keys are random and namespaced per institute (or per independent teacher), so URLs cannot be guessed.
export function storageKey({ instituteId, teacherId, classId, kind, ext }) {
  const scope = instituteId ? `i${instituteId}` : `t${teacherId}`;
  return `${scope}/c${classId}/${kind}/${crypto.randomUUID()}.${ext}`;
}
