// Manage administrators of the question bank admin dashboard.
//
//   npm run admin -- list
//   npm run admin -- grant someone@example.com
//   npm run admin -- revoke someone@example.com
//
// Uses DB_FILE or data/dermmcq.sqlite. The account must already exist (sign up first).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('../src/core');

const ROOT = path.join(__dirname, '..');
const dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'dermmcq.sqlite');
const [cmd, emailArg] = process.argv.slice(2);
if (!fs.existsSync(dbFile)) {
  console.error(`${path.relative(ROOT, dbFile)} does not exist yet. Start the app (npm start) or run npm run db:seed first.`);
  process.exit(1);
}
const sqlite = new DatabaseSync(dbFile);
const db = { all: (q, p = []) => sqlite.prepare(q).all(...p), exec: (q) => sqlite.exec(q) };
migrate(db);

if (cmd === 'list') {
  const rows = sqlite.prepare('SELECT email, name FROM users WHERE is_admin = 1 ORDER BY email').all();
  console.log(rows.length ? rows.map((r) => `${r.email} (${r.name})`).join('\n') : 'No administrators yet.');
} else if (cmd === 'grant' || cmd === 'revoke') {
  const email = String(emailArg || '').trim().toLowerCase();
  const user = email && sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(email ? `No account with the email ${email}. Sign up in the app first.` : 'Give the account email.');
    process.exit(1);
  }
  sqlite.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(cmd === 'grant' ? 1 : 0, user.id);
  console.log(`${email} is ${cmd === 'grant' ? 'now an administrator' : 'no longer an administrator'}.`);
} else {
  console.error('Usage: npm run admin -- list | grant <email> | revoke <email>');
  process.exit(1);
}
