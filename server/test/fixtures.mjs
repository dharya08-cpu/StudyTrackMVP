// Builders for real (and deliberately malicious) test files.
import zlib from "node:zlib";
import { crc32 } from "../src/files.js";

export const makePdf = (extra = "") => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");

function chunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
export function makePng({ width = 1, height = 1, trailing = null, badCrc = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  const parts = [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))];
  const png = Buffer.concat(parts);
  if (badCrc) png[png.length - 1] ^= 0xFF;
  return trailing ? Buffer.concat([png, Buffer.from(trailing)]) : png;
}
export function makeJpeg({ width = 8, height = 8, comment = "", dropEoi = false } = {}) {
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x0B, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const com = comment ? Buffer.concat([Buffer.from([0xFF, 0xFE, (comment.length + 2) >> 8, (comment.length + 2) & 255]), Buffer.from(comment)]) : Buffer.alloc(0);
  const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x12, 0x34]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, com, sof, sos, dropEoi ? Buffer.alloc(0) : Buffer.from([0xFF, 0xD9])]);
}
// Minimal ZIP writer (deflate or stored) so DOCX variants can be built exactly.
export function makeZip(entries, { method = 8 } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content), data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.concat([local, nameBuf, data]);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head); central.push(Buffer.concat([cd, nameBuf])); offset += head.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
export const makeDocx = (extra = {}, ct = CT) => makeZip({ "[Content_Types].xml": ct, "word/document.xml": "<w:document/>", ...extra });
export const upload = (buffer, originalname, mimetype = "application/octet-stream") => ({ buffer, originalname, mimetype, size: buffer.length });
