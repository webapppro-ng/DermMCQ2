// Creates a database from a SQL seed file.
//
//   npm run db:seed                         # db/seed/dermmcq-seed.sql -> data/dermmcq.sqlite
//   npm run db:seed -- --fresh              # delete the existing database first (removes all users and progress)
//   npm run db:seed -- --file other.sql --db other.sqlite
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const sqlFile = opt('--file', path.join(ROOT, 'db', 'seed', 'dermmcq-seed.sql'));
const dbFile = opt('--db', process.env.DB_FILE || path.join(ROOT, 'data', 'dermmcq.sqlite'));
const fresh = args.includes('--fresh');

if (!fs.existsSync(sqlFile)) {
  console.error(`Seed file not found: ${sqlFile}. Run "npm run db:export" to create it.`);
  process.exit(1);
}
if (fs.existsSync(dbFile)) {
  if (!fresh) {
    console.error(`${path.relative(ROOT, dbFile)} already exists. To replace it, run "npm run db:seed -- --fresh". ` +
      'That deletes all users, answers and flags in it.');
    process.exit(1);
  }
  fs.rmSync(dbFile);
}

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const sqlite = new DatabaseSync(dbFile);
try {
  sqlite.exec(fs.readFileSync(sqlFile, 'utf8'));
} catch (err) {
  sqlite.close();
  fs.rmSync(dbFile, { force: true });
  console.error(`Seeding failed, so no database was created: ${err.message}`);
  process.exit(1);
}
const count = (t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Created ${path.relative(ROOT, dbFile)} from ${path.relative(ROOT, sqlFile)}: ${count('topics')} topics, ${count('questions')} questions.`);
sqlite.close();
