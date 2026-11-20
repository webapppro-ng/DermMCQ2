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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../public/rich.js'));
  else root.DermCore = factory(root.DermRich);
})(typeof self !== 'undefined' ? self : this, function (rich) {
  'use strict';

  const SESSION_DAYS = 30;
  const OPTIONS = ['A', 'B', 'C', 'D', 'E'];

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // Brings an existing database up to the current schema (CREATE TABLE IF NOT EXISTS cannot add columns).
  function migrate(db) {
    const cols = db.all('PRAGMA table_info(users)', []).map((c) => c.name);
    if (!cols.includes('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    const qcols = db.all('PRAGMA table_info(questions)', []).map((c) => c.name);
    if (!qcols.includes('stem_html')) db.exec("ALTER TABLE questions ADD COLUMN stem_html TEXT NOT NULL DEFAULT ''");
    if (!qcols.includes('explanation_html')) db.exec("ALTER TABLE questions ADD COLUMN explanation_html TEXT NOT NULL DEFAULT ''");
    // Questions stored before rich text: build their rich text from the plain text (explanations as bullets).
    for (const q of db.all("SELECT id, stem, explanation FROM questions WHERE stem_html = '' OR explanation_html = ''", [])) {
      db.run('UPDATE questions SET stem_html = ?, explanation_html = ? WHERE id = ?',
        [rich.textToHtml(q.stem, false), rich.textToHtml(q.explanation, true), q.id]);
    }
  }

  // Creates the schema and loads the question file.
  //   mode 'missing' (default): load the file only into an empty question bank. Once a bank exists the
  //     database is the source of truth, so edits made in the admin dashboard are never overwritten.
  //   mode 'sync': make the bank match the file (npm run db:sync). Topics are added, renamed, reordered
  //     and removed; questions are matched by stem and first option, so an existing question keeps its id
  //     (and users' answers to it) while its other fields are updated; new questions are inserted;
  //     questions no longer in the file are deleted together with users' answers, flags and redo attempts.
  function seed(db, schemaSql, topicsData, mode = 'missing') {
    db.exec(schemaSql);
    migrate(db);
    if (mode !== 'sync' && Number(db.get('SELECT COUNT(*) AS n FROM questions', []).n) > 0) return 0;
    let added = 0;
    db.exec('BEGIN');
    try {
      const keep = new Set();
      topicsData.forEach((t, i) => {
        const found = db.get('SELECT id FROM topics WHERE slug = ?', [t.slug]);
        const topicId = found
          ? found.id
          : db.run('INSERT INTO topics (slug, name, sort_order) VALUES (?, ?, ?)', [t.slug, t.name, i]).lastInsertRowid;
        db.run('UPDATE topics SET name = ?, sort_order = ? WHERE id = ?', [t.name, i, topicId]);
        for (const q of t.questions) {
          if (q.options.length !== 5) throw new Error(`Question needs 5 options: ${q.stem}`);
          if (!OPTIONS.includes(q.answer)) throw new Error(`Bad answer letter: ${q.stem}`);
          // A question is identified by its stem plus first option (some stems, e.g. "Which is false?", repeat).
          const existing = db.get('SELECT id FROM questions WHERE stem = ? AND option_a = ?', [q.stem, q.options[0]]);
          // The file holds plain text, optionally with stemHtml / explanationHtml for rich text.
          const values = [topicId, ...q.options, q.answer, q.explanation,
            q.stemHtml || rich.textToHtml(q.stem, false), q.explanationHtml || rich.textToHtml(q.explanation, true)];
          if (existing) {
            db.run(
              `UPDATE questions SET topic_id = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, option_e = ?,
                      correct_option = ?, explanation = ?, stem_html = ?, explanation_html = ? WHERE id = ?`,
              [...values, existing.id]
            );
            keep.add(Number(existing.id));
            continue;
          }
          const { lastInsertRowid } = db.run(
            `INSERT INTO questions
               (topic_id, option_a, option_b, option_c, option_d, option_e, correct_option, explanation, stem_html, explanation_html, stem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...values, q.stem]
          );
          keep.add(Number(lastInsertRowid));
          added++;
        }
      });
      for (const row of db.all('SELECT id FROM questions', [])) {
        if (!keep.has(Number(row.id))) {
          db.run('DELETE FROM answers WHERE question_id = ?', [row.id]);
          db.run('DELETE FROM flags WHERE question_id = ?', [row.id]);
          db.run('DELETE FROM redo_attempts WHERE question_id = ?', [row.id]);
          db.run('DELETE FROM questions WHERE id = ?', [row.id]);
        }
      }
      const slugs = topicsData.map((t) => t.slug);
      db.run(`DELETE FROM topics WHERE slug NOT IN (${slugs.map(() => '?').join(', ')})`, slugs);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  // options.adminEmails: emails that are made administrators when they sign up or log in.
  // options.firstUserIsAdmin: the first account created becomes an administrator (single-device prototype).
  function createApp(db, crypto, options = {}) {
    const adminEmails = new Set((options.adminEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));

    function publicUser(u) {
      return { id: Number(u.id), name: u.name, email: u.email, isAdmin: !!Number(u.is_admin) };
    }

    function promoteIfListed(user) {
      if (adminEmails.has(String(user.email).toLowerCase()) && !Number(user.is_admin)) {
        db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id]);
        user.is_admin = 1;
      }
      return user;
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
        `SELECT u.id, u.name, u.email, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
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

    function requireAdmin(token) {
      const user = requireUser(token);
      if (!Number(user.is_admin)) throw new HttpError(403, 'Only administrators can use the question bank admin.');
      return user;
    }

    function adminQuestion(id) {
      const r = db.get(
        `SELECT q.*, t.slug AS topic_slug, t.name AS topic_name,
                (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) AS answered,
                (SELECT COUNT(*) FROM flags f WHERE f.question_id = q.id) AS flags
           FROM questions q JOIN topics t ON t.id = q.topic_id WHERE q.id = ?`,
        [id]
      );
      if (!r) return null;
      return {
        id: Number(r.id),
        topic: r.topic_slug,
        topicName: r.topic_name,
        stem: r.stem,
        stemHtml: r.stem_html,
        options: OPTIONS.map((k) => r['option_' + k.toLowerCase()]),
        answer: r.correct_option,
        explanation: r.explanation,
        explanationHtml: r.explanation_html,
        answered: Number(r.answered),
        flags: Number(r.flags),
      };
    }

    // Validates an admin edit; returns the clean fields or throws a message naming what to fix.
    function questionInput(body) {
      const topic = db.get('SELECT id FROM topics WHERE slug = ?', [String(body.topic || '')]);
      if (!topic) throw new HttpError(400, 'Choose a topic.');
      if (!options.sanitizeHtml) throw new HttpError(500, 'Rich text is not available on this server.');
      // Rich text is sanitized against the allowlist in public/rich.js; plain text is accepted too.
      const richField = (htmlKey, textKey, asList, label) => {
        const raw = body[htmlKey] !== undefined ? String(body[htmlKey]) : rich.textToHtml(body[textKey], asList);
        if (raw.length > rich.MAX_LENGTH) throw new HttpError(400, `The ${label} is too large. Use smaller or fewer images.`);
        const html = options.sanitizeHtml(raw).trim();
        if (!rich.hasContent(html)) throw new HttpError(400, `Enter the ${label}.`);
        return html;
      };
      const stemHtml = richField('stemHtml', 'stem', false, 'question stem');
      const stem = rich.htmlToText(stemHtml) || '[image]';
      const opts = Array.isArray(body.options) ? body.options.map((o) => String(o || '').trim()) : [];
      if (opts.length !== 5) throw new HttpError(400, 'A question needs exactly five answer options.');
      const empty = opts.findIndex((o) => !o);
      if (empty !== -1) throw new HttpError(400, `Enter text for option ${OPTIONS[empty]}.`);
      const answer = String(body.answer || '').toUpperCase();
      if (!OPTIONS.includes(answer)) throw new HttpError(400, 'Mark which option is correct.');
      const explanationHtml = richField('explanationHtml', 'explanation', true, 'explanation');
      const explanation = rich.htmlToText(explanationHtml) || '[image]';
      return { topicId: topic.id, stem, stemHtml, opts, answer, explanation, explanationHtml };
    }

    // Questions first answered incorrectly whose latest re-attempt (if any) was not correct.
    // Never-retried questions come first, then the ones retried longest ago, so a question
    // answered wrongly again goes to the back of the queue.
    const REDO_FROM = `
        FROM answers a
        JOIN questions q ON q.id = a.question_id
        JOIN topics t    ON t.id = q.topic_id
        LEFT JOIN redo_attempts r ON r.question_id = a.question_id AND r.user_id = a.user_id
       WHERE a.user_id = ? AND a.is_correct = 0 AND COALESCE(r.is_correct, 0) = 0`;

    function redoSummary(userId) {
      const topics = db.all(
        `SELECT t.slug, t.name, COUNT(*) AS remaining ${REDO_FROM} GROUP BY t.id ORDER BY t.sort_order`,
        [userId]
      ).map((r) => ({ slug: r.slug, name: r.name, remaining: Number(r.remaining) }));
      const corrected = Number(db.get(
        `SELECT COUNT(*) AS n FROM answers a JOIN redo_attempts r ON r.question_id = a.question_id AND r.user_id = a.user_id
          WHERE a.user_id = ? AND a.is_correct = 0 AND r.is_correct = 1`,
        [userId]
      ).n);
      return { remaining: topics.reduce((n, t) => n + t.remaining, 0), corrected, topics };
    }

    function flagState(userId, questionId) {
      const f = db.get('SELECT note FROM flags WHERE user_id = ? AND question_id = ?', [userId, questionId]);
      return { flagged: !!f, note: f ? f.note : '' };
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
        if (options.firstUserIsAdmin && Number(db.get('SELECT COUNT(*) AS n FROM users', []).n) === 1) {
          db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [lastInsertRowid]);
        }
        const user = promoteIfListed(db.get('SELECT id, name, email, is_admin FROM users WHERE id = ?', [lastInsertRowid]));
        return { body: { user: publicUser(user) }, token: startSession(lastInsertRowid) };
      },

      async 'POST /api/login'({ body }) {
        const email = String(body.email || '').trim().toLowerCase();
        const user = db.get('SELECT id, name, email, is_admin, password_hash FROM users WHERE email = ?', [email]);
        const ok = user && (await crypto.verifyPassword(String(body.password || ''), user.password_hash));
        if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
        promoteIfListed(user);
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
        const flagged = Number(db.get('SELECT COUNT(*) AS n FROM flags WHERE user_id = ?', [user.id]).n);
        const { remaining, corrected } = redoSummary(user.id);
        return { body: { topics: topicStats(user.id), flagged, redo: { remaining, corrected } } };
      },

      // Next question to redo, from all topics ('all') or one topic (its slug).
      async 'GET /api/redo/:scope/next'({ token, params }) {
        const user = requireUser(token);
        const scope = params.scope === 'all' ? null : topicBySlug(params.scope);
        const q = db.get(
          `SELECT q.id, q.stem, q.stem_html, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
                  t.slug AS topic_slug, t.name AS topic_name, a.selected_option AS first_selected,
                  r.selected_option AS last_selected
             ${REDO_FROM} ${scope ? 'AND q.topic_id = ?' : ''}
            ORDER BY COALESCE(r.attempted_at, '') ASC, a.answered_at ASC, q.id ASC
            LIMIT 1`,
          scope ? [user.id, scope.id] : [user.id]
        );
        return {
          body: {
            summary: redoSummary(user.id),
            scope: scope ? { slug: scope.slug, name: scope.name } : null,
            question: q
              ? {
                  id: Number(q.id),
                  stem: q.stem,
                  stemHtml: q.stem_html,
                  options: OPTIONS.map((k) => ({ key: k, text: q['option_' + k.toLowerCase()] })),
                  topic: { slug: q.topic_slug, name: q.topic_name },
                  previous: q.last_selected || q.first_selected,
                  retried: !!q.last_selected,
                  ...flagState(user.id, q.id),
                }
              : null,
          },
        };
      },

      async 'POST /api/redo/answer'({ token, body }) {
        const user = requireUser(token);
        const questionId = Number(body.questionId);
        const selected = String(body.selected || '').toUpperCase();
        if (!OPTIONS.includes(selected)) throw new HttpError(400, 'Choose one of the five answers.');
        const first = db.get('SELECT is_correct FROM answers WHERE user_id = ? AND question_id = ?', [user.id, questionId]);
        if (!first || Number(first.is_correct) === 1) throw new HttpError(409, 'That question is not on your redo list.');
        const q = db.get('SELECT correct_option, explanation, explanation_html FROM questions WHERE id = ?', [questionId]);
        const isCorrect = selected === q.correct_option ? 1 : 0;
        const at = new Date().toISOString();
        if (db.get('SELECT id FROM redo_attempts WHERE user_id = ? AND question_id = ?', [user.id, questionId])) {
          db.run('UPDATE redo_attempts SET selected_option = ?, is_correct = ?, attempted_at = ? WHERE user_id = ? AND question_id = ?',
            [selected, isCorrect, at, user.id, questionId]);
        } else {
          db.run('INSERT INTO redo_attempts (user_id, question_id, selected_option, is_correct, attempted_at) VALUES (?, ?, ?, ?, ?)',
            [user.id, questionId, selected, isCorrect, at]);
        }
        return {
          body: { correct: !!isCorrect, selected, correctOption: q.correct_option, explanation: q.explanation, explanationHtml: q.explanation_html, summary: redoSummary(user.id) },
        };
      },

      async 'GET /api/topics/:slug/next'({ token, params }) {
        const user = requireUser(token);
        const topic = topicBySlug(params.slug);
        const q = db.get(
          `SELECT q.id, q.stem, q.stem_html, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e
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
                  stemHtml: q.stem_html,
                  options: OPTIONS.map((k) => ({ key: k, text: q['option_' + k.toLowerCase()] })),
                  ...flagState(user.id, q.id),
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
        const q = db.get('SELECT id, correct_option, explanation, explanation_html FROM questions WHERE id = ?', [questionId]);
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
          body: { correct: !!isCorrect, selected, correctOption: q.correct_option, explanation: q.explanation, explanationHtml: q.explanation_html },
        };
      },

      // Flag (or update the note on) a question for later review. Works whether or not it has been answered.
      async 'PUT /api/flags/:id'({ token, params, body }) {
        const user = requireUser(token);
        const questionId = Number(params.id);
        if (!db.get('SELECT id FROM questions WHERE id = ?', [questionId])) throw new HttpError(404, 'That question does not exist.');
        const note = String(body.note || '').trim();
        if (note.length > 500) throw new HttpError(400, 'Keep the note under 500 characters.');
        if (db.get('SELECT id FROM flags WHERE user_id = ? AND question_id = ?', [user.id, questionId])) {
          db.run('UPDATE flags SET note = ? WHERE user_id = ? AND question_id = ?', [note, user.id, questionId]);
        } else {
          db.run('INSERT INTO flags (user_id, question_id, note, flagged_at) VALUES (?, ?, ?, ?)',
            [user.id, questionId, note, new Date().toISOString()]);
        }
        return { body: flagState(user.id, questionId) };
      },

      async 'DELETE /api/flags/:id'({ token, params }) {
        const user = requireUser(token);
        db.run('DELETE FROM flags WHERE user_id = ? AND question_id = ?', [user.id, Number(params.id)]);
        return { body: { flagged: false, note: '' } };
      },

      // Everything needed to review flagged questions, newest flag first.
      async 'GET /api/flags'({ token }) {
        const user = requireUser(token);
        const rows = db.all(
          `SELECT q.id, q.stem, q.stem_html, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.correct_option,
                  q.explanation, q.explanation_html, t.slug AS topic_slug, t.name AS topic_name, f.note, f.flagged_at,
                  a.selected_option, a.is_correct
             FROM flags f
             JOIN questions q ON q.id = f.question_id
             JOIN topics t    ON t.id = q.topic_id
             LEFT JOIN answers a ON a.question_id = q.id AND a.user_id = f.user_id
            WHERE f.user_id = ?
            ORDER BY f.flagged_at DESC, f.id DESC`,
          [user.id]
        );
        return {
          body: {
            questions: rows.map((r) => ({
              id: Number(r.id),
              stem: r.stem,
              stemHtml: r.stem_html,
              options: OPTIONS.map((k) => ({ key: k, text: r['option_' + k.toLowerCase()] })),
              correctOption: r.correct_option,
              explanation: r.explanation,
              explanationHtml: r.explanation_html,
              topic: { slug: r.topic_slug, name: r.topic_name },
              note: r.note,
              flaggedAt: r.flagged_at,
              answer: r.selected_option ? { selected: r.selected_option, correct: !!Number(r.is_correct) } : null,
            })),
          },
        };
      },

      // ----- Question bank admin (administrators only) -----
      async 'GET /api/admin/questions'({ token }) {
        requireAdmin(token);
        const topics = db.all('SELECT slug, name FROM topics ORDER BY sort_order', []);
        const ids = db.all(
          'SELECT q.id FROM questions q JOIN topics t ON t.id = q.topic_id ORDER BY t.sort_order, q.id', []
        );
        return { body: { topics, questions: ids.map((r) => adminQuestion(r.id)) } };
      },

      async 'POST /api/admin/questions'({ token, body }) {
        requireAdmin(token);
        const q = questionInput(body);
        const { lastInsertRowid } = db.run(
          `INSERT INTO questions (topic_id, stem, option_a, option_b, option_c, option_d, option_e, correct_option, explanation,
                                  stem_html, explanation_html)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [q.topicId, q.stem, ...q.opts, q.answer, q.explanation, q.stemHtml, q.explanationHtml]
        );
        return { body: { question: adminQuestion(lastInsertRowid), remarked: 0 } };
      },

      // Saves every field of a question. If the correct option changes, users' answers and redo
      // attempts for this question are re-marked against the new key.
      async 'PUT /api/admin/questions/:id'({ token, params, body }) {
        requireAdmin(token);
        const id = Number(params.id);
        const before = db.get('SELECT correct_option FROM questions WHERE id = ?', [id]);
        if (!before) throw new HttpError(404, 'That question no longer exists.');
        const q = questionInput(body);
        db.run(
          `UPDATE questions SET topic_id = ?, stem = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, option_e = ?,
                  correct_option = ?, explanation = ?, stem_html = ?, explanation_html = ? WHERE id = ?`,
          [q.topicId, q.stem, ...q.opts, q.answer, q.explanation, q.stemHtml, q.explanationHtml, id]
        );
        let remarked = 0;
        if (before.correct_option !== q.answer) {
          remarked = Number(db.get('SELECT COUNT(*) AS n FROM answers WHERE question_id = ?', [id]).n);
          for (const table of ['answers', 'redo_attempts']) {
            db.run(`UPDATE ${table} SET is_correct = CASE WHEN selected_option = ? THEN 1 ELSE 0 END WHERE question_id = ?`, [q.answer, id]);
          }
        }
        return { body: { question: adminQuestion(id), remarked } };
      },

      // Stores an image for rich text and returns the URL to embed. The browser resizes images first.
      async 'POST /api/admin/images'({ token, body }) {
        requireAdmin(token);
        if (!options.saveImage) throw new HttpError(500, 'Image upload is not available here.');
        const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
        if (!m) throw new HttpError(400, 'Upload a PNG, JPEG, GIF or WebP image.');
        if (m[2].length * 0.75 > 3 * 1024 * 1024) throw new HttpError(400, 'Images must be under 3 MB.');
        const url = await options.saveImage({ mime: m[1], base64: m[2] });
        return { body: { url } };
      },

      async 'DELETE /api/admin/questions/:id'({ token, params }) {
        requireAdmin(token);
        const id = Number(params.id);
        if (!db.get('SELECT id FROM questions WHERE id = ?', [id])) throw new HttpError(404, 'That question no longer exists.');
        for (const table of ['answers', 'flags', 'redo_attempts']) db.run(`DELETE FROM ${table} WHERE question_id = ?`, [id]);
        db.run('DELETE FROM questions WHERE id = ?', [id]);
        return { body: { ok: true } };
      },

      async 'POST /api/topics/:slug/reset'({ token, params }) {
        const user = requireUser(token);
        const topic = topicBySlug(params.slug);
        for (const table of ['answers', 'redo_attempts']) {
          db.run(
            `DELETE FROM ${table} WHERE user_id = ? AND question_id IN (SELECT id FROM questions WHERE topic_id = ?)`,
            [user.id, topic.id]
          );
        }
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

  return { seed, migrate, createApp, HttpError };
});
