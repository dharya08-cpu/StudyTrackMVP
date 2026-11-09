-- V6 features: due-date reminders, login alerts, parent view, student submission files.

-- ---- Settings (on the account) ------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN reminders_checked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN login_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ---- Reminders ----------------------------------------------------------------------------------------------
-- One row per reminder already sent, so a student gets "due tomorrow" once, "due today" once and "overdue" once.
CREATE TABLE reminders_sent (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('homework','plan','test','exam')),
  item_id INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('tomorrow','today','overdue')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_type, item_id, stage)
);

-- ---- Login alerts -------------------------------------------------------------------------------------------
-- The kinds of device (browser + operating system) an account has signed in from. A sign-in from a kind of device
-- that is not on this list triggers an alert. No IP addresses and no precise identifiers are stored here.
CREATE TABLE known_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  label TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

-- ---- Parent view --------------------------------------------------------------------------------------------
-- A student can share a read-only weekly summary through a secret link. Only a hash of the secret is stored.
CREATE TABLE parent_links (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_parent_links_student ON parent_links(student_id);

-- ---- Files a student attaches to a homework submission ------------------------------------------------------
CREATE TABLE submission_files (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES homework_submissions(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_type TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_submission_files_submission ON submission_files(submission_id, id);
CREATE INDEX idx_submission_files_class ON submission_files(class_id);
