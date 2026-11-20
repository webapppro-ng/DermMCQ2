'use strict';

const path = require('node:path');
const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const { seed, createApp } = require('./core');
const rich = require('../public/rich.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'dermmcq.sqlite');
const COOKIE = 'dermmcq_session';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const sqlite = new DatabaseSync(DB_FILE);
const db = {
  all: (sql, params = []) => sqlite.prepare(sql).all(...params),
  get: (sql, params = []) => sqlite.prepare(sql).get(...params),
  run: (sql, params = []) => sqlite.prepare(sql).run(...params),
  exec: (sql) => sqlite.exec(sql),
};

const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'questions.json'), 'utf8'));
// The question file only fills an empty bank; after that the database (edited in the admin dashboard)
// is the source of truth. Run `npm run db:sync` to apply changes made to db/questions.json.
const added = seed(db, schema, questions);
if (added) console.log(`Loaded ${added} questions into the empty bank.`);

const scrypt = promisify(nodeCrypto.scrypt);
const crypto = {
  async hashPassword(pw) {
    const salt = nodeCrypto.randomBytes(16);
    const key = await scrypt(pw, salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  },
  async verifyPassword(pw, stored) {
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
    return nodeCrypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  },
  randomToken: () => nodeCrypto.randomBytes(32).toString('hex'),
};

// Comma-separated emails that become administrators when they sign up or log in.
// Accounts can also be promoted with `npm run admin -- grant <email>`.
const app = createApp(db, crypto, {
  adminEmails: (process.env.ADMIN_EMAILS || '').split(','),
  sanitizeHtml: rich.nodeSanitizer(sanitizeHtml),
  // Uploaded images live in the database and are embedded in rich text as /media/<id>.
  saveImage({ mime, base64 }) {
    const { lastInsertRowid } = db.run('INSERT INTO images (mime, data) VALUES (?, ?)', [mime, Buffer.from(base64, 'base64')]);
    return `/media/${lastInsertRowid}`;
  },
});
const server = express();
server.use(express.json({ limit: '6mb' })); // rich text can carry an image upload

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

server.all('/api/*splat', async (req, res, next) => {
  try {
    const out = await app.handle(req.method, req.path, req.body, readCookie(req, COOKIE));
    if (out.token) {
      res.cookie(COOKIE, out.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 864e5,
      });
    } else if (out.token === null) {
      res.clearCookie(COOKIE);
    }
    res.set('Cache-Control', 'no-store'); // API responses are per-user and change after every answer
    res.status(out.status).json(out.body);
  } catch (err) {
    next(err);
  }
});

server.get('/media/:id', (req, res) => {
  const img = /^\d+$/.test(req.params.id) && db.get('SELECT mime, data FROM images WHERE id = ?', [Number(req.params.id)]);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(img.data));
});

// Editor and sanitizer served from node_modules (the hosted build loads the same versions from a CDN).
const VENDOR = {
  'quill.js': 'quill/dist/quill.js',
  'quill.snow.css': 'quill/dist/quill.snow.css',
  'purify.min.js': 'dompurify/dist/purify.min.js',
};
server.get('/vendor/:file', (req, res) => {
  const file = VENDOR[req.params.file];
  if (!file) return res.status(404).end();
  res.sendFile(path.join(ROOT, 'node_modules', file));
});

server.use(express.static(path.join(ROOT, 'public')));

server.listen(PORT, () => console.log(`DermMCQ running at http://localhost:${PORT}`));
