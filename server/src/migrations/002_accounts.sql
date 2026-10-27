-- V4.1: password accounts (e-mail verification, reset), onboarding profile, demo accounts.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN parent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN parent_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN grade TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN school TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN subjects TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN profile_completed_at TIMESTAMPTZ;

-- One-time links sent by e-mail (verify address / reset password). Only a hash of the token is stored.
CREATE TABLE email_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose, created_at);
