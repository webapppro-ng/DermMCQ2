// Applies db/questions.json to an existing database (see seed() in src/core.js, mode 'sync').
// This overwrites admin-dashboard edits to questions that are also in the file, and deletes
// questions that are not in it (with users' answers to them).
//
//   npm run db:sync
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { seed } = require('../src/core');

const ROOT = path.join(__dirname, '..');
const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'dermmcq.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const sqlite = new DatabaseSync(dbFile);
const db = {
  all: (q, p = []) => sqlite.prepare(q).all(...p),
  get: (q, p = []) => sqlite.prepare(q).get(...p),
  run: (q, p = []) => sqlite.prepare(q).run(...p),
  exec: (q) => sqlite.exec(q),
};
const before = Number(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'questions'").n)
  ? Number(db.get('SELECT COUNT(*) AS n FROM questions').n) : 0;
const added = seed(db, fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'questions.json'), 'utf8')), 'sync');
const after = Number(db.get('SELECT COUNT(*) AS n FROM questions').n);
console.log(`Synced ${path.relative(ROOT, dbFile)} with db/questions.json: ${before} -> ${after} questions (${added} added).`);
