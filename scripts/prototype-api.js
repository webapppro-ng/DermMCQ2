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
  // Stable key for a question that survives reordering of the question file (FNV-1a of the stem).
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

  let app, sql, mode = 'local', token = null, persist = async () => {};

  const ready = (async () => {
    const SQL = await initSqlJs();
    const shared = await sharedCapabilities().catch(() => null);

    if (shared) {
      mode = 'shared';
      sql = new SQL.Database();
      const db = adapter(sql);
      DermCore.seed(db, window.DERM_SCHEMA, window.DERM_SEED);
      app = DermCore.createApp(db, cryptoImpl);
      const me = await shared.userCap.me();
      const userId = db.run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)',
        ['viewer@claude.ai', me.name || '', '!']).lastInsertRowid;
      db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '9999-12-31')", [SHARED_TOKEN, userId]);
      token = SHARED_TOKEN;

      const keyToId = {}, idToKey = {};
      for (const q of db.all('SELECT id, stem FROM questions')) {
        const k = stemKey(q.stem);
        keyToId[k] = q.id; idToKey[q.id] = k;
      }
      const progressRef = shared.db.doc('data/users/' + shared.uid + '/progress');
      const snap = await progressRef.get();
      const saved = (snap.exists && snap.data().answers) || {};
      for (const [k, a] of Object.entries(saved)) {
        if (!keyToId[k] || !/^[A-E]$/.test(a.s)) continue;
        db.run('INSERT OR IGNORE INTO answers (user_id, question_id, selected_option, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)',
          [userId, keyToId[k], a.s, a.c ? 1 : 0, String(a.at || '')]);
      }

      let chain = Promise.resolve();
      persist = () => {
        const answers = {};
        for (const r of db.all('SELECT question_id, selected_option, is_correct, answered_at FROM answers WHERE user_id = ?', [userId])) {
          answers[idToKey[r.question_id]] = { s: r.selected_option, c: r.is_correct, at: r.answered_at };
        }
        chain = chain
          .then(() => progressRef.set({ answers, updatedAt: new Date().toISOString() }))
          .then(() => setNote('Your progress is saved to your claude.ai account and follows you across devices.'))
          .catch(() => setNote('Your answers could not be saved, so progress will be lost when you leave. Ask the owner of this page for Contributor access.'));
        return chain;
      };
      setNote('Signed in with your claude.ai account. Progress is saved and follows you across devices.');
      return;
    }

    const saved = store.get(DB_KEY);
    try { sql = saved ? new SQL.Database(fromB64(saved)) : new SQL.Database(); }
    catch (e) { sql = new SQL.Database(); }
    DermCore.seed(adapter(sql), window.DERM_SCHEMA, window.DERM_SEED);
    app = DermCore.createApp(adapter(sql), cryptoImpl);
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
