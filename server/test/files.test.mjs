import test from "node:test";
import assert from "node:assert/strict";
import { inspectUpload, storageKey } from "../src/files.js";
import { makePdf, makePng, makeJpeg, makeDocx, makeZip } from "./fixtures.mjs";

const MAX = 15 * 1024 * 1024;
const check = (buffer, originalName, declaredMime = "") => inspectUpload({ buffer, originalName, declaredMime, maxBytes: MAX });
const rejects = (fn, status) => assert.throws(fn, e => (status ? e.status === status : e.status >= 400) && e.code === "UPLOAD_REJECTED");

test("accepts genuine PDF, PNG, JPEG and DOCX", () => {
  assert.equal(check(makePdf(), "Notes.PDF", "application/pdf").type, "pdf");
  assert.equal(check(makePng(), "a.png", "image/png").ext, "png");
  assert.equal(check(makeJpeg(), "p.jpeg", "image/jpeg").ext, "jpg");
  assert.equal(check(makeJpeg(), "p.jpg").type, "jpeg");
  assert.equal(check(makeDocx(), "hw.docx").type, "docx");
});
test("blocked by extension: exe, js, html, svg, php and no extension", () => {
  for (const name of ["a.exe", "a.js", "a.html", "a.svg", "a.php", "a.docm", "noext", "a.pdf.exe"]) rejects(() => check(makePdf(), name));
});
test("content must match extension (renamed files are caught)", () => {
  rejects(() => check(Buffer.from("MZ\x90\x00 fake exe"), "evil.pdf"));
  rejects(() => check(Buffer.from("<html><script>alert(1)</script></html>"), "x.pdf"));
  rejects(() => check(makePng(), "x.pdf"));
  rejects(() => check(makePdf(), "x.png"));
  rejects(() => check(makeDocx(), "x.pdf"));
});
test("declared MIME type from the client must agree with the real content", () => {
  rejects(() => check(makePdf(), "a.pdf", "text/html"));
  rejects(() => check(makePng(), "a.png", "application/pdf"));
  assert.ok(check(makePdf(), "a.pdf", "application/octet-stream"));
});
test("size is enforced on the real bytes, empty files rejected", () => {
  rejects(() => check(Buffer.alloc(0), "a.pdf"), 400);
  const big = Buffer.concat([makePdf(), Buffer.alloc(MAX)]);
  rejects(() => check(big, "a.pdf"), 413);
});
test("PDF with JavaScript, launch actions, embedded files or hex-obfuscated names is rejected", () => {
  for (const extra of ["/JavaScript 5 0 R", "/JS (app.alert(1))", "/Launch << >>", "/EmbeddedFile", "/OpenAction 3 0 R", "/J#61vaScript 1 0 R"]) rejects(() => check(makePdf(extra), "a.pdf"), 415);
  rejects(() => check(Buffer.from("%PDF-1.4 truncated"), "a.pdf"), 400);
});
test("PNG: corrupt CRC, trailing hidden data and decompression-bomb dimensions are rejected", () => {
  rejects(() => check(makePng({ badCrc: true }), "a.png"));
  rejects(() => check(makePng({ trailing: "<script>alert(1)</script>" }), "a.png"));
  rejects(() => check(makePng({ width: 20000, height: 20000 }), "a.png"), 413);
});
test("JPEG: hidden script in a comment, missing end marker and huge dimensions are rejected", () => {
  rejects(() => check(makeJpeg({ comment: "<script>alert(1)</script>" }), "a.jpg"));
  rejects(() => check(makeJpeg({ dropEoi: true }), "a.jpg"), 400);
  rejects(() => check(makeJpeg({ width: 65000, height: 65000 }), "a.jpg"), 400);
});
test("DOCX: macros, embedded objects, executables, zip-slip and fake docx are rejected", () => {
  rejects(() => check(makeDocx({ "word/vbaProject.bin": "x" }), "a.docx"));
  rejects(() => check(makeDocx({ "word/embeddings/o.bin": "x" }), "a.docx"));
  rejects(() => check(makeDocx({ "run.exe": "MZ" }), "a.docx"));
  rejects(() => check(makeDocx({ "../evil.txt": "x" }), "a.docx"));
  rejects(() => check(makeDocx({}, '<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>'), "a.docx"));
  rejects(() => check(makeZip({ "hello.txt": "hi" }), "a.docx"));
  rejects(() => check(Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(40)]), "a.docx"), 400);
  const bomb = makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "x", "word/big.xml": Buffer.alloc(30 * 1024 * 1024) });
  rejects(() => check(bomb, "a.docx"));
  assert.ok(check(makeDocx({}, "<Types/>").length ? makeDocx({}, "<Types/>") : null, "ok.docx"));
});
test("stored name is random, namespaced per institute/teacher and uses the DETECTED extension", () => {
  const a = storageKey({ instituteId: 5, teacherId: 9, classId: 2, kind: "homework", ext: "pdf" }), b = storageKey({ instituteId: 5, teacherId: 9, classId: 2, kind: "homework", ext: "pdf" });
  assert.match(a, /^i5\/c2\/homework\/[0-9a-f-]{36}\.pdf$/);
  assert.notEqual(a, b);
  assert.match(storageKey({ instituteId: null, teacherId: 9, classId: 2, kind: "tests", ext: "png" }), /^t9\/c2\/tests\//);
  assert.equal(check(makePdf(), "../../etc/passwd.pdf").displayName, "passwd.pdf");
  assert.equal(check(makePdf(), "we<ird>\u202Efdp.pdf").displayName.includes("\u202E"), false);
});
