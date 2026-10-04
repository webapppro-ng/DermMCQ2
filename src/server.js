'use strict';

const path = require('node:path');
const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { seed, createApp } = require('./core');

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
const added = seed(db, schema, questions);
if (added) console.log(`Added ${added} questions to the bank.`);

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

const app = createApp(db, crypto);
const server = express();
server.use(express.json());

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

server.use(express.static(path.join(ROOT, 'public')));

server.listen(PORT, () => console.log(`DermMCQ running at http://localhost:${PORT}`));
