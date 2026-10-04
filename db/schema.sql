-- DermMCQ schema (SQLite). Shared by the Node server and the in-browser prototype.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY,
  topic_id       INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  stem           TEXT NOT NULL,
  option_a       TEXT NOT NULL,
  option_b       TEXT NOT NULL,
  option_c       TEXT NOT NULL,
  option_d       TEXT NOT NULL,
  option_e       TEXT NOT NULL,
  correct_option TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D','E')),
  explanation    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- One row per user per question: a question counts as "answered" once.
CREATE TABLE IF NOT EXISTS answers (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_option TEXT NOT NULL CHECK (selected_option IN ('A','B','C','D','E')),
  is_correct      INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  answered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);

-- Questions a user has flagged for review, with an optional note.
CREATE TABLE IF NOT EXISTS flags (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  note        TEXT NOT NULL DEFAULT '',
  flagged_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_flags_user ON flags(user_id);
