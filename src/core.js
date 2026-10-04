/*
 * Application core: every API route, written against a tiny SQL adapter.
 *
 * Runs unchanged in two places:
 *   - Node (src/server.js) on top of node:sqlite
 *   - the browser prototype (scripts/build-prototype.js) on top of sql.js
 *
 * The adapter must provide:
 *   db.all(sql, params) -> rows[]
 *   db.get(sql, params) -> row | undefined
 *   db.run(sql, params) -> { lastInsertRowid }
 *   db.exec(sql)
 * and the platform must provide:
 *   crypto.hashPassword(pw) -> Promise<string>
 *   crypto.verifyPassword(pw, hash) -> Promise<boolean>
 *   crypto.randomToken() -> string
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DermCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SESSION_DAYS = 30;
  const OPTIONS = ['A', 'B', 'C', 'D', 'E'];

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function seed(db, schemaSql, topicsData) {
    db.exec(schemaSql);
    const existing = db.get('SELECT COUNT(*) AS n FROM topics', []);
    if (existing && Number(existing.n) > 0) return false;
    db.exec('BEGIN');
    try {
      topicsData.forEach((t, i) => {
        const { lastInsertRowid: topicId } = db.run(
          'INSERT INTO topics (slug, name, sort_order) VALUES (?, ?, ?)',
          [t.slug, t.name, i]
        );
        for (const q of t.questions) {
          if (q.options.length !== 5) throw new Error(`Question needs 5 options: ${q.stem}`);
          if (!OPTIONS.includes(q.answer)) throw new Error(`Bad answer letter: ${q.stem}`);
          db.run(
            `INSERT INTO questions
               (topic_id, stem, option_a, option_b, option_c, option_d, option_e, correct_option, explanation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [topicId, q.stem, ...q.options, q.answer, q.explanation]
          );
        }
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return true;
  }

  function createApp(db, crypto) {
    function publicUser(u) {
      return { id: Number(u.id), name: u.name, email: u.email };
    }

    function startSession(userId) {
      const token = crypto.randomToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expires]);
      return token;
    }

    function userFromToken(token) {
      if (!token) return null;
      const row = db.get(
        `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
        [token, new Date().toISOString()]
      );
      return row || null;
    }

    function requireUser(token) {
      const user = userFromToken(token);
      if (!user) throw new HttpError(401, 'Please log in to continue.');
      return user;
    }

    function topicBySlug(slug) {
      const t = db.get('SELECT id, slug, name FROM topics WHERE slug = ?', [slug]);
      if (!t) throw new HttpError(404, 'That topic does not exist.');
      return t;
    }

    function topicStats(userId) {
      return db.all(
        `SELECT t.id, t.slug, t.name,
                COUNT(q.id)                          AS total,
                COUNT(a.id)                          AS answered,
                COALESCE(SUM(a.is_correct), 0)       AS correct
           FROM topics t
           LEFT JOIN questions q ON q.topic_id = t.id
           LEFT JOIN answers a   ON a.question_id = q.id AND a.user_id = ?
          GROUP BY t.id
          ORDER BY t.sort_order`,
        [userId]
      ).map((r) => ({
        slug: r.slug,
        name: r.name,
        total: Number(r.total),
        answered: Number(r.answered),
        correct: Number(r.correct),
      }));
    }

    const routes = {
      async 'POST /api/signup'({ body }) {
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!name) throw new HttpError(400, 'Enter your name.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
        if (password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
        if (db.get('SELECT id FROM users WHERE email = ?', [email])) {
          throw new HttpError(409, 'An account with that email already exists. Log in instead.');
        }
        const hash = await crypto.hashPassword(password);
        const { lastInsertRowid } = db.run(
          'INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)',
          [email, name, hash]
        );
        const user = { id: lastInsertRowid, name, email };
        return { body: { user: publicUser(user) }, token: startSession(lastInsertRowid) };
      },

      async 'POST /api/login'({ body }) {
        const email = String(body.email || '').trim().toLowerCase();
        const user = db.get('SELECT id, name, email, password_hash FROM users WHERE email = ?', [email]);
        const ok = user && (await crypto.verifyPassword(String(body.password || ''), user.password_hash));
        if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
        return { body: { user: publicUser(user) }, token: startSession(user.id) };
      },

      async 'POST /api/logout'({ token }) {
        if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
        return { body: { ok: true }, token: null };
      },

      async 'GET /api/me'({ token }) {
        const user = userFromToken(token);
        return { body: { user: user ? publicUser(user) : null } };
      },

      async 'GET /api/topics'({ token }) {
        const user = requireUser(token);
        return { body: { topics: topicStats(user.id) } };
      },

      async 'GET /api/topics/:slug/next'({ token, params }) {
        const user = requireUser(token);
        const topic = topicBySlug(params.slug);
        const q = db.get(
          `SELECT q.id, q.stem, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e
             FROM questions q
            WHERE q.topic_id = ?
              AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id AND a.user_id = ?)
            ORDER BY q.id
            LIMIT 1`,
          [topic.id, user.id]
        );
        const progress = topicStats(user.id).find((t) => t.slug === topic.slug);
        return {
          body: {
            topic: { slug: topic.slug, name: topic.name },
            progress,
            question: q
              ? {
                  id: Number(q.id),
                  stem: q.stem,
                  options: OPTIONS.map((k) => ({ key: k, text: q['option_' + k.toLowerCase()] })),
                }
              : null,
          },
        };
      },

      async 'POST /api/answer'({ token, body }) {
        const user = requireUser(token);
        const questionId = Number(body.questionId);
        const selected = String(body.selected || '').toUpperCase();
        if (!OPTIONS.includes(selected)) throw new HttpError(400, 'Choose one of the five answers.');
        const q = db.get('SELECT id, correct_option, explanation FROM questions WHERE id = ?', [questionId]);
        if (!q) throw new HttpError(404, 'That question does not exist.');
        if (db.get('SELECT id FROM answers WHERE user_id = ? AND question_id = ?', [user.id, questionId])) {
          throw new HttpError(409, 'You have already answered this question.');
        }
        const isCorrect = selected === q.correct_option ? 1 : 0;
        db.run(
          'INSERT INTO answers (user_id, question_id, selected_option, is_correct) VALUES (?, ?, ?, ?)',
          [user.id, questionId, selected, isCorrect]
        );
        return {
          body: { correct: !!isCorrect, selected, correctOption: q.correct_option, explanation: q.explanation },
        };
      },

      async 'POST /api/topics/:slug/reset'({ token, params }) {
        const user = requireUser(token);
        const topic = topicBySlug(params.slug);
        db.run(
          'DELETE FROM answers WHERE user_id = ? AND question_id IN (SELECT id FROM questions WHERE topic_id = ?)',
          [user.id, topic.id]
        );
        return { body: { ok: true } };
      },

      async 'GET /api/stats'({ token }) {
        const user = requireUser(token);
        const topics = topicStats(user.id);
        const sum = (k) => topics.reduce((n, t) => n + t[k], 0);
        return {
          body: { overall: { total: sum('total'), answered: sum('answered'), correct: sum('correct') }, topics },
        };
      },
    };

    const table = Object.keys(routes).map((key) => {
      const [method, pattern] = key.split(' ');
      const names = [];
      const re = new RegExp(
        '^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$'
      );
      return { method, re, names, fn: routes[key] };
    });

    // Returns { status, body, token? } where token === undefined means "leave the session alone".
    async function handle(method, path, body, token) {
      for (const r of table) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
        try {
          const out = await r.fn({ body: body || {}, token, params });
          return { status: 200, body: out.body, token: out.token };
        } catch (err) {
          if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
          throw err;
        }
      }
      return { status: 404, body: { error: 'Not found.' } };
    }

    return { handle };
  }

  return { seed, createApp, HttpError };
});
