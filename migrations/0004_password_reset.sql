CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS password_reset_teacher
  ON password_reset_tokens(teacher_id);
CREATE INDEX IF NOT EXISTS password_reset_expiry
  ON password_reset_tokens(expires);
