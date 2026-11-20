// Prototype build: runs the same SQLite schema and route code entirely in the browser via sql.js.
//
// Two modes, picked at load:
//   shared — hosted on claude.ai with the artifact database available: the viewer is identified by their
//            claude.ai account and their answers are saved to the artifact database, so progress follows
//            them across devices. Questions come from the page itself.
//   local  — anywhere else: email/password accounts, with the whole SQLite file kept in localStorage.
(function () {
  'use strict';
  const DB_KEY = 'dermmcq-db-v1';
  const TOKEN_KEY = 'dermmcq-token';
  const SHARED_TOKEN = 'shared-session';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable: session-only */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  // Stable key for a question that survives reordering of the question file (FNV-1a of stem + first option).
  const stemKey = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return 'q' + h.toString(16).padStart(8, '0'); };

  async function pbkdf2(pw, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256));
  }
  const cryptoImpl = {
    async hashPassword(pw) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      return `pbkdf2$${hex(salt)}$${await pbkdf2(pw, salt)}`;
    },
    async verifyPassword(pw, stored) {
      const [scheme, saltHex, keyHex] = String(stored).split('$');
      if (scheme !== 'pbkdf2') return false;
      const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
      return (await pbkdf2(pw, salt)) === keyHex;
    },
    randomToken: () => hex(crypto.getRandomValues(new Uint8Array(32))),
  };

  function adapter(sql) {
    const db = {
      all(q, params = []) {
        const st = sql.prepare(q); st.bind(params);
        const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free();
        return rows;
      },
      get(q, params = []) { return db.all(q, params)[0]; },
      run(q, params = []) {
        sql.run(q, params);
        return { lastInsertRowid: sql.exec('SELECT last_insert_rowid()')[0].values[0][0] };
      },
      exec(q) { sql.exec(q); },
    };
    return db;
  }

  function setNote(text) {
    const el = document.getElementById('mode-note');
    if (el) el.textContent = text;
  }

  // Resolves { db, userCap, uid } when the claude.ai artifact database is usable for this viewer, else null.
  async function sharedCapabilities() {
    if (!window.claude || typeof window.claude.use !== 'function') return null;
    const [db, userCap] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !userCap) return null;
    const uid = await userCap.id();
    return uid ? { db, userCap, uid } : null;
  }

  const appOptions = (extra) => Object.assign({ sanitizeHtml: window.DOMPurify ? DermRich.sanitizeInBrowser : undefined }, extra);
  const dataUrlToBlob = (mime, base64) => new Blob([fromB64(base64)], { type: mime });
  const EDITS = 'questionEdits'; // shared collection: the owner's question-bank edits, one document per question
  let app, sql, mode = 'local', token = null, persist = async () => {}, saveEdit = null;

  const ready = (async () => {
    const SQL = await initSqlJs();
    const shared = await sharedCapabilities().catch(() => null);

    if (shared) {
      mode = 'shared';
      sql = new SQL.Database();
      const db = adapter(sql);
      DermCore.seed(db, window.DERM_SCHEMA, window.DERM_SEED);
      // Images go to the page's asset store (writers only; null for everyone else).
      const assets = await window.claude.use('assets').catch(() => null);
      app = DermCore.createApp(db, cryptoImpl, appOptions({
        saveImage: assets ? async ({ mime, base64 }) => {
          try {
            const up = await assets.upload(dataUrlToBlob(mime, base64), { type: mime });
            return '/_blob/' + up.id; // durable path that resolves in every view of the page
          } catch (e) {
            throw new DermCore.HttpError(400, e && e.code === 'too_large' ? 'That image is too large.' : 'The image could not be uploaded. Try again.');
          }
        } : undefined,
      }));
      const me = await shared.userCap.me();
      // The page's owner is the administrator of the shared question bank.
      const userId = db.run('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)',
        ['viewer@claude.ai', me.name || '', '!', me.isOwner ? 1 : 0]).lastInsertRowid;
      db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '9999-12-31')", [SHARED_TOKEN, userId]);
      token = SHARED_TOKEN;

      // Keys come from the questions as shipped in the page, before edits, so progress saved against a
      // question still finds it after its stem or options are edited.
      const keyToId = {}, idToKey = {};
      for (const q of db.all('SELECT id, stem, option_a FROM questions')) {
        const k = stemKey(q.stem + '\n' + q.option_a);
        keyToId[k] = q.id; idToKey[q.id] = k;
      }
      const topicId = (slug) => (db.get('SELECT id FROM topics WHERE slug = ?', [slug]) || {}).id;
      const edits = await shared.db.collection(EDITS).limit(1000).get().catch(() => ({ docs: [] }));
      for (const d of edits.docs) {
        const e = d.data() || {};
        const id = keyToId[d.id];
        if (e.deleted) {
          if (id) { db.run('DELETE FROM questions WHERE id = ?', [id]); delete keyToId[d.id]; delete idToKey[id]; }
          continue;
        }
        const tid = topicId(e.topic);
        if (!tid || !Array.isArray(e.options) || e.options.length !== 5 || !/^[A-E]$/.test(e.answer)) continue;
        // Shared documents are untrusted: rich text is sanitized again before use.
        const stemHtml = DermRich.sanitizeInBrowser(e.stemHtml || DermRich.textToHtml(e.stem, false));
        const explanationHtml = DermRich.sanitizeInBrowser(e.explanationHtml || DermRich.textToHtml(e.explanation, true));
        const values = [tid, DermRich.htmlToText(stemHtml) || String(e.stem || '[image]'), ...e.options.map(String), e.answer,
          DermRich.htmlToText(explanationHtml) || String(e.explanation || '[image]'), stemHtml, explanationHtml];
        if (id) {
          db.run(`UPDATE questions SET topic_id = ?, stem = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, option_e = ?,
                  correct_option = ?, explanation = ?, stem_html = ?, explanation_html = ? WHERE id = ?`, [...values, id]);
        } else {
          const nid = db.run(`INSERT INTO questions (topic_id, stem, option_a, option_b, option_c, option_d, option_e, correct_option, explanation,
                                stem_html, explanation_html) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values).lastInsertRowid;
          keyToId[d.id] = nid; idToKey[nid] = d.id;
        }
      }
      // Writes one admin change to the shared bank so every viewer gets it on their next visit.
      saveEdit = async (method, path, out) => {
        const at = new Date().toISOString();
        if (method === 'DELETE') {
          const id = Number(path.split('/').pop());
          const k = idToKey[id];
          delete keyToId[k]; delete idToKey[id];
          return shared.db.collection(EDITS).doc(k).set({ deleted: true, at });
        }
        const q = out.body.question;
        if (!idToKey[q.id]) { const k = 'n' + hex(crypto.getRandomValues(new Uint8Array(8))); idToKey[q.id] = k; keyToId[k] = q.id; }
        return shared.db.collection(EDITS).doc(idToKey[q.id]).set({
          topic: q.topic, stem: q.stem, stemHtml: q.stemHtml, options: q.options, answer: q.answer,
          explanation: q.explanation, explanationHtml: q.explanationHtml, at,
        });
      };
      const progressRef = shared.db.doc('data/users/' + shared.uid + '/progress');
      const snap = await progressRef.get();
      const savedDoc = (snap.exists && snap.data()) || {};
      for (const [k, a] of Object.entries(savedDoc.answers || {})) {
        if (!keyToId[k] || !/^[A-E]$/.test(a.s)) continue;
        db.run('INSERT OR IGNORE INTO answers (user_id, question_id, selected_option, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)',
          [userId, keyToId[k], a.s, a.c ? 1 : 0, String(a.at || '')]);
      }
      for (const [k, a] of Object.entries(savedDoc.redo || {})) {
        if (!keyToId[k] || !/^[A-E]$/.test(a.s)) continue;
        db.run('INSERT OR IGNORE INTO redo_attempts (user_id, question_id, selected_option, is_correct, attempted_at) VALUES (?, ?, ?, ?, ?)',
          [userId, keyToId[k], a.s, a.c ? 1 : 0, String(a.at || '')]);
      }
      for (const [k, f] of Object.entries(savedDoc.flags || {})) {
        if (!keyToId[k]) continue;
        db.run('INSERT OR IGNORE INTO flags (user_id, question_id, note, flagged_at) VALUES (?, ?, ?, ?)',
          [userId, keyToId[k], String((f && f.n) || '').slice(0, 500), String((f && f.at) || '')]);
      }
      // Re-mark saved answers against the current key, in case the owner has changed an answer since.
      for (const table of ['answers', 'redo_attempts']) {
        db.run(`UPDATE ${table} SET is_correct = CASE WHEN selected_option =
                  (SELECT correct_option FROM questions q WHERE q.id = ${table}.question_id) THEN 1 ELSE 0 END`);
      }

      let chain = Promise.resolve();
      persist = () => {
        const answers = {};
        for (const r of db.all('SELECT question_id, selected_option, is_correct, answered_at FROM answers WHERE user_id = ?', [userId])) {
          answers[idToKey[r.question_id]] = { s: r.selected_option, c: r.is_correct, at: r.answered_at };
        }
        const flags = {};
        for (const r of db.all('SELECT question_id, note, flagged_at FROM flags WHERE user_id = ?', [userId])) {
          flags[idToKey[r.question_id]] = { n: r.note, at: r.flagged_at };
        }
        const redo = {};
        for (const r of db.all('SELECT question_id, selected_option, is_correct, attempted_at FROM redo_attempts WHERE user_id = ?', [userId])) {
          redo[idToKey[r.question_id]] = { s: r.selected_option, c: r.is_correct, at: r.attempted_at };
        }
        chain = chain
          .then(() => progressRef.set({ answers, flags, redo, updatedAt: new Date().toISOString() }))
          .then(() => setNote('Your progress is saved to your claude.ai account and follows you across devices.'))
          .catch(() => setNote('Your answers and flags could not be saved, so they will be lost when you leave. Ask the owner of this page for Contributor access.'));
        return chain;
      };
      setNote('Signed in with your claude.ai account. Progress is saved and follows you across devices.');
      return;
    }

    const saved = store.get(DB_KEY);
    try { sql = saved ? new SQL.Database(fromB64(saved)) : new SQL.Database(); }
    catch (e) { sql = new SQL.Database(); }
    DermCore.seed(adapter(sql), window.DERM_SCHEMA, window.DERM_SEED);
    // Single-device prototype: the first account created in this browser administers its question bank.
    sql.run(`UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)
               AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);
    // Browser-only build: images are kept inline in the rich text.
    app = DermCore.createApp(adapter(sql), cryptoImpl, appOptions({
      firstUserIsAdmin: true,
      saveImage: ({ mime, base64 }) => `data:${mime};base64,${base64}`,
    }));
    token = store.get(TOKEN_KEY);
    persist = async () => {
      store.set(DB_KEY, toB64(sql.export()));
      sql.exec('PRAGMA foreign_keys = ON');
    };
    await persist();
    setNote('Prototype mode: the database runs in your browser, so accounts and answers are saved on this device only.');
  })();

  window.DermAPI = async function (method, path, body) {
    await ready;
    if (mode === 'shared' && /^\/api\/(signup|login|logout)$/.test(path)) {
      return { status: 400, body: { error: 'You are signed in with your claude.ai account.' } };
    }
    const out = await app.handle(method, path, body ? JSON.parse(JSON.stringify(body)) : null, token);
    if (saveEdit && method !== 'GET' && out.status === 200 && path.startsWith('/api/admin/questions')) {
      try {
        await saveEdit(method, path, out);
      } catch (e) {
        return { status: 500, body: { error: 'The change was made on this page but could not be saved to the shared question bank. Reload and try again.' } };
      }
    }
    if (mode === 'local') {
      if (out.token) { token = out.token; store.set(TOKEN_KEY, token); }
      else if (out.token === null) { token = null; store.del(TOKEN_KEY); }
    }
    if (method !== 'GET' && out.status === 200) persist();
    return { status: out.status, body: out.body };
  };
  window.DermAPI.ready = ready;
  Object.defineProperty(window.DermAPI, 'mode', { get: () => mode });
})();
