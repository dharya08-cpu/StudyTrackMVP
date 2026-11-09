// Teacher downloads: the current class as an Excel workbook (all sheets) or a CSV of one sheet.
import { HttpError, v } from "../validate.js";
import { classForReq } from "../classctx.js";
import { buildClassReport } from "../class-export.js";
import { buildXlsx, buildCsv } from "../xlsx.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEETS = { summary: "Summary", results: "Results", attendance: "Attendance", homework: "Homework" };
const safeName = s => String(s).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "class";

export function exportRoutes(ctx, r) {
  const { db, clock, auth, role, limiters } = ctx;
  r.get("/api/teacher/export", auth, role("teacher"), limiters.heavy.guard, async (req, res) => {
    const cls = await classForReq(db, req); // always one of this teacher's own classes
    const format = req.query.format === undefined ? "xlsx" : v.oneOf(String(req.query.format), "Format", ["xlsx", "csv"]);
    const sheet = req.query.sheet === undefined ? "summary" : v.oneOf(String(req.query.sheet), "Sheet", Object.keys(SHEETS));
    const range = {};
    if (req.query.from) range.from = v.date(String(req.query.from), "From date");
    if (req.query.to) range.to = v.date(String(req.query.to), "To date");
    if (range.from && range.to && range.to < range.from) throw new HttpError(400, "The end date cannot be before the start date");
    if (range.from && range.to && clock.daysBetween(range.from, range.to) > 400) throw new HttpError(400, "Choose a range of at most 400 days");
    const report = await buildClassReport(db, clock, cls, range);
    const base = `StudyTrack-${safeName(cls.name)}-${clock.today()}`;
    await ctx.audit(req, "class_export", `${format}:${format === "csv" ? sheet : "all"}`);
    const body = format === "csv"
      ? buildCsv(report[sheet])
      : buildXlsx([...Object.entries(SHEETS).map(([key, name]) => ({ name, rows: report[key] })), { name: "About", rows: report.about, frozenCols: 0 }], clock.now());
    res.set("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : XLSX_TYPE);
    res.set("Content-Disposition", `attachment; filename="${base}${format === "csv" ? `-${sheet}.csv` : ".xlsx"}"`);
    res.send(body);
  });
}
