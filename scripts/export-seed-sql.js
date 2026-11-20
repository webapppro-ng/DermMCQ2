// Writes the question bank (topics and questions only, never users or their progress) from a
// database to a standalone SQL seed file.
//
//   npm run db:export                       # data/dermmcq.sqlite -> db/seed/dermmcq-seed.sql
//   npm run db:export -- other.sqlite out.sql
//
// If the database file does not exist, the bank is built in memory from db/questions.json.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { seed } = require('../src/core');

const ROOT = path.join(__dirname, '..');
const dbFile = process.argv[2] || process.env.DB_FILE || path.join(ROOT, 'data', 'dermmcq.sqlite');
const outFile = process.argv[3] || path.join(ROOT, 'db', 'seed', 'dermmcq-seed.sql');
const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');

let sqlite;
if (fs.existsSync(dbFile)) {
  sqlite = new DatabaseSync(dbFile); // opened writable so an older database can be brought up to the current schema
} else {
  console.log(`${path.relative(ROOT, dbFile)} not found; building the bank from db/questions.json.`);
  sqlite = new DatabaseSync(':memory:');
  const db = {
    all: (q, p = []) => sqlite.prepare(q).all(...p),
    get: (q, p = []) => sqlite.prepare(q).get(...p),
    run: (q, p = []) => sqlite.prepare(q).run(...p),
    exec: (q) => sqlite.exec(q),
  };
  seed(db, schema, JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'questions.json'), 'utf8')));
}

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'`
  : `'${String(v).replace(/'/g, "''")}'`);
const { migrate } = require('../src/core');
migrate({ all: (q, p = []) => sqlite.prepare(q).all(...p), run: (q, p = []) => sqlite.prepare(q).run(...p), exec: (q) => sqlite.exec(q) });
const topics = sqlite.prepare('SELECT id, slug, name, sort_order FROM topics ORDER BY sort_order, id').all();
const questions = sqlite.prepare(
  `SELECT q.id, q.topic_id, q.stem, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.correct_option, q.explanation,
          q.stem_html, q.explanation_html
     FROM questions q JOIN topics t ON t.id = q.topic_id ORDER BY t.sort_order, q.id`
).all();
const hasImages = sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'images'").get().n > 0;
const images = hasImages ? sqlite.prepare('SELECT id, mime, data FROM images ORDER BY id').all() : [];

const lines = [
  '-- DermMCQ question bank seed',
  `-- Generated ${new Date().toISOString().slice(0, 10)} by scripts/export-seed-sql.js: ${topics.length} topics, ${questions.length} questions, ${images.length} images.`,
  '-- Contains the schema plus topics, questions (plain and rich text) and the images they embed; no users, answers or flags.',
  '--',
  '-- Seed a new database:   npm run db:seed',
  '--                  or:   sqlite3 data/dermmcq.sqlite < db/seed/dermmcq-seed.sql',
  '-- Regenerate this file:  npm run db:export',
  '',
  schema.trim(),
  '',
  'BEGIN;',
  '',
  '-- Topics',
  ...topics.map((t) => `INSERT INTO topics (id, slug, name, sort_order) VALUES (${[t.id, t.slug, t.name, t.sort_order].map(lit).join(', ')});`),
];
let current = null;
for (const q of questions) {
  if (q.topic_id !== current) {
    current = q.topic_id;
    lines.push('', `-- ${topics.find((t) => t.id === current).name}`);
  }
  lines.push(
    'INSERT INTO questions (id, topic_id, stem, option_a, option_b, option_c, option_d, option_e, correct_option, explanation, stem_html, explanation_html) VALUES (' +
      [q.id, q.topic_id, q.stem, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.correct_option, q.explanation, q.stem_html, q.explanation_html].map(lit).join(', ') +
      ');'
  );
}
if (images.length) {
  lines.push('', '-- Images embedded in rich text as /media/<id>');
  for (const im of images) lines.push(`INSERT INTO images (id, mime, data) VALUES (${[im.id, im.mime, im.data].map(lit).join(', ')});`);
}
lines.push('', 'COMMIT;', '');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`Wrote ${path.relative(ROOT, outFile)}: ${topics.length} topics, ${questions.length} questions.`);
