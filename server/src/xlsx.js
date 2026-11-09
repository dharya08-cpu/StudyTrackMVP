// A tiny, dependency-free writer for Excel (.xlsx) and CSV files, so StudyTrack needs no spreadsheet library.
// Text is always written as plain text (inline strings), so a student named "=HYPERLINK(...)" can never run as a formula
// in Excel. CSV cells that start with = + - @ are neutralised for the same reason (spreadsheet formula injection).
import zlib from "node:zlib";

// ---- CRC-32 (needed by the zip format) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buffer) { let c = 0xFFFFFFFF; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// ---- A minimal zip writer (deflate) ----
export function zip(files, date = new Date()) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((Math.max(date.getUTCFullYear(), 1980) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8"), data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const packed = zlib.deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- Text safety ----
// XML 1.0 cannot contain most control characters; one in a student's name would make the whole file unreadable.
const clean = value => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const xml = value => clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const column = index => { let n = index + 1, s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const MAX_CELL = 32000;

// Styles: 0 plain, 1 header (bold, shaded, wrapped), 2 number with one decimal, 3 centred text
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetXml(rows, { frozenRows = 1, frozenCols = 1 } = {}) {
  const widths = [];
  const lines = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell === null || cell === undefined || cell === "") return "";
      const ref = `${column(c)}${r + 1}`;
      const isHeader = r === 0;
      if (typeof cell === "number" && Number.isFinite(cell)) { widths[c] = Math.max(widths[c] || 0, 8); return `<c r="${ref}" s="${isHeader ? 1 : Number.isInteger(cell) ? 0 : 2}"><v>${cell}</v></c>`; }
      const text = clean(cell).slice(0, MAX_CELL);
      widths[c] = Math.max(widths[c] || 0, Math.min(isHeader ? 18 : 40, text.length + 2));
      const style = isHeader ? 1 : text.length <= 2 && c > 0 ? 3 : 0;
      return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}"${r === 0 ? ' ht="32" customHeight="1"' : ""}>${cells}</row>`;
  }).join("");
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(w || 8, 8)}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = frozenRows || frozenCols ? `<sheetViews><sheetView workbookViewId="0"><pane${frozenCols ? ` xSplit="${frozenCols}"` : ""}${frozenRows ? ` ySplit="${frozenRows}"` : ""} topLeftCell="${column(frozenCols)}${frozenRows + 1}" activePane="${frozenCols && frozenRows ? "bottomRight" : frozenRows ? "bottomLeft" : "topRight"}" state="frozen"/></sheetView></sheetViews>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${lines}</sheetData></worksheet>`;
}

// sheets: [{ name, rows: [[header...], [value...], ...], frozenCols? }]
export function buildXlsx(sheets, date = new Date()) {
  const used = new Set();
  const named = sheets.map((s, i) => {
    let base = clean(s.name).replace(/[\\/?*[\]:]/g, "-").trim().slice(0, 31) || `Sheet${i + 1}`, name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${n++}`;
    used.add(name.toLowerCase());
    return { ...s, name };
  });
  const sheetFiles = named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, { frozenRows: 1, frozenCols: s.frozenCols ?? 1 }) }));
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES },
    ...sheetFiles,
  ], date);
}

// ---- CSV (UTF-8 with a byte-order mark so Excel shows accents and Indian-language names correctly) ----
const csvCell = value => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = clean(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // formula-injection guard
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const buildCsv = rows => Buffer.from(`\uFEFF${rows.map(r => r.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
