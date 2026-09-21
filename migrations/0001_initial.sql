PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  options TEXT NOT NULL,
  correct INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  started INTEGER,
  closed INTEGER
);
CREATE INDEX IF NOT EXISTS questions_session ON questions(code, position);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_question
  ON questions(code) WHERE started IS NOT NULL AND closed IS NULL;

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  name TEXT NOT NULL,
  joined INTEGER NOT NULL,
  UNIQUE(code, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS answers (
  question TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  participant TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  created INTEGER NOT NULL,
  elapsed INTEGER NOT NULL,
  PRIMARY KEY(question, participant)
);
