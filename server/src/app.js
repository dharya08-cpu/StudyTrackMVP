// Assembles routes and middleware. The same arrays are mounted on Express (server.js) and run by the test harness.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter, errorHandler } from "./router.js";
import { securityHeaders, corsMiddleware, cookieMiddleware, originGuard } from "./security.js";
import { authRoutes } from "./routes/auth.js";
import { studentRoutes } from "./routes/student.js";
import { teacherClassRoutes } from "./routes/teacher-classes.js";
import { teacherAcademicRoutes } from "./routes/teacher-academic.js";
import { communicationRoutes } from "./routes/communication.js";
import { plannerRoutes } from "./routes/planner.js";
import { fileRoutes } from "./routes/files.js";
import { instituteRoutes } from "./routes/institute.js";
import { adminRoutes } from "./routes/admin.js";

export function buildRoutes(ctx) {
  const r = createRouter();
  r.get("/api/health", async (req, res) => { await ctx.db.one("SELECT 1 AS ok"); res.json({ ok: true }); });
  authRoutes(ctx, r);
  studentRoutes(ctx, r);
  teacherClassRoutes(ctx, r);
  teacherAcademicRoutes(ctx, r);
  communicationRoutes(ctx, r);
  plannerRoutes(ctx, r);
  fileRoutes(ctx, r);
  instituteRoutes(ctx, r);
  adminRoutes(ctx, r);
  return r.routes;
}
// Everything every /api request passes through before its route.
export const pageMiddleware = ctx => [securityHeaders(ctx.config)];
export const apiMiddleware = ctx => [corsMiddleware(ctx.config), ctx.limiters.api.guard, cookieMiddleware, originGuard(ctx.config)];

export async function createExpressApp(ctx) {
  const express = (await import("express")).default;
  const { config } = ctx;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(...pageMiddleware(ctx));
  app.use("/api", ...apiMiddleware(ctx), express.json({ limit: "100kb", strict: true }));
  for (const route of buildRoutes(ctx)) app[route.method](route.path, ...route.mw, route.handler);
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use(express.static(dist, { index: false, maxAge: "1h", dotfiles: "ignore" }));
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"), err => { if (err) next(); });
  });
  app.use(errorHandler(config));
  return app;
}
