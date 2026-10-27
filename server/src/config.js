// Central, validated configuration. Production refuses to start with missing or weak settings.
const list = value => String(value || "").split(",").map(s => s.trim()).filter(Boolean);
const origin = value => { try { return new URL(value).origin; } catch { return null; } };

export function loadConfig(env = process.env) {
  const get = (key, fallback = "") => String(env[key] ?? fallback).trim();
  const int = (key, fallback, min, max) => {
    const n = Number(get(key, String(fallback)));
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const nodeEnv = get("NODE_ENV", "development");
  const isProd = nodeEnv === "production";
  const isTest = nodeEnv === "test";
  const problems = [];

  const appUrls = list(get("APP_URL") || (isProd ? "" : "http://localhost:5000,http://localhost:3001,http://localhost:5173")).map(origin);
  if (appUrls.some(o => !o)) problems.push("APP_URL must be a comma-separated list of full URLs such as https://studytrack.onrender.com");
  const clientOrigins = list(get("CLIENT_ORIGIN")).map(origin);
  if (clientOrigins.some(o => !o)) problems.push("CLIENT_ORIGIN must be a comma-separated list of full URLs");

  const sessionSecret = get("SESSION_SECRET", isProd ? "" : "dev-only-session-secret-change-me-0123456789");
  const adminKey = get("ADMIN_KEY");
  const trustProxyRaw = Number(get("TRUST_PROXY"));
  const cfg = {
    nodeEnv, isProd, isTest,
    port: int("PORT", 3001, 1, 65535),
    trustProxy: Number.isInteger(trustProxyRaw) && trustProxyRaw >= 0 ? trustProxyRaw : (isProd ? 1 : 0),
    databaseUrl: get("DATABASE_URL"),
    databaseSsl: get("DATABASE_SSL", isProd ? "require" : "disable"),
    databaseCa: get("DATABASE_CA_CERT").replace(/\\n/g, "\n"),
    dbPoolMax: int("DB_POOL_MAX", 10, 1, 50),
    appOrigins: appUrls.filter(Boolean),
    corsOrigins: clientOrigins.filter(Boolean),
    sessionSecret,
    adminKey,
    googleClientId: get("GOOGLE_CLIENT_ID"),
    timezone: get("STUDYTRACK_TIMEZONE", "Asia/Kolkata"),
    supabase: {
      url: get("SUPABASE_URL"),
      serviceKey: get("SUPABASE_SERVICE_ROLE_KEY"),
      bucket: get("SUPABASE_BUCKET", "studytrack-files"),
      backupBucket: get("SUPABASE_BACKUP_BUCKET", "studytrack-backups"),
    },
    maxUploadBytes: int("MAX_UPLOAD_MB", 15, 1, 50) * 1024 * 1024,
    sessionAbsoluteDays: int("SESSION_MAX_DAYS", 30, 1, 90),
    sessionIdleDays: int("SESSION_IDLE_DAYS", 14, 1, 60),
    maxSessionsPerUser: int("MAX_SESSIONS_PER_USER", 10, 1, 50),
    teacherSignupLimit: int("TEACHER_SIGNUP_LIMIT", 20, 1, 100000),
    allowDemo: get("ALLOW_DEMO", "false") === "true",
    mail: {
      provider: get("MAIL_PROVIDER", isProd ? "none" : "console"),
      webhookUrl: get("MAIL_WEBHOOK_URL"), webhookToken: get("MAIL_WEBHOOK_TOKEN"),
      resendKey: get("RESEND_API_KEY"), from: get("MAIL_FROM"),
    },
    backup: {
      enabled: get("BACKUP_ENABLED", isProd ? "true" : "false") === "true",
      dailyKeep: int("BACKUP_DAILY_KEEP", 14, 1, 365),
      weeklyKeep: int("BACKUP_WEEKLY_KEEP", 8, 1, 104),
      weeklyDay: int("BACKUP_WEEKLY_DAY", 0, 0, 6),
    },
  };
  if (cfg.databaseSsl && !["disable", "require", "verify"].includes(cfg.databaseSsl)) problems.push("DATABASE_SSL must be disable, require or verify");
  if (!["none", "console", "webhook", "resend"].includes(cfg.mail.provider)) problems.push("MAIL_PROVIDER must be none, webhook or resend");
  if (cfg.mail.provider === "webhook" && (!/^https:\/\//.test(cfg.mail.webhookUrl) || cfg.mail.webhookToken.length < 12)) problems.push("MAIL_PROVIDER=webhook needs MAIL_WEBHOOK_URL (https) and MAIL_WEBHOOK_TOKEN (12+ characters)");
  if (cfg.mail.provider === "resend" && (!cfg.mail.resendKey || !cfg.mail.from)) problems.push("MAIL_PROVIDER=resend needs RESEND_API_KEY and MAIL_FROM");
  if (isProd && cfg.mail.provider === "console") problems.push("MAIL_PROVIDER=console is for development only");
  if (isProd) {
    if (!cfg.databaseUrl) problems.push("DATABASE_URL is required (Supabase Postgres connection string)");
    if (sessionSecret.length < 32) problems.push("SESSION_SECRET must be at least 32 random characters");
    if (adminKey.length < 12) problems.push("ADMIN_KEY must be at least 12 characters");
    if (!cfg.googleClientId) problems.push("GOOGLE_CLIENT_ID is required because StudyTrack signs in with Google only");
    if (!cfg.appOrigins.length) problems.push("APP_URL is required (the public https URL of this app)");
    if (cfg.appOrigins.some(o => !o.startsWith("https://"))) problems.push("APP_URL must use https in production");
    if (!cfg.supabase.url || !cfg.supabase.serviceKey) problems.push("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for file storage and backups");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
  return cfg;
}
