// Prototype build: runs the same SQLite schema and route code entirely in the browser via sql.js.
// The database is saved to this browser's localStorage, so accounts and answers stay on this device.
(function () {
  'use strict';
  const DB_KEY = 'dermmcq-db-v1';
  const TOKEN_KEY = 'dermmcq-token';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable: session-only */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

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

  let app, sql;
  const ready = (async () => {
    const SQL = await initSqlJs();
    const saved = store.get(DB_KEY);
    try { sql = saved ? new SQL.Database(fromB64(saved)) : new SQL.Database(); }
    catch (e) { sql = new SQL.Database(); }
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
    DermCore.seed(db, window.DERM_SCHEMA, window.DERM_SEED);
    app = DermCore.createApp(db, cryptoImpl);
    store.set(DB_KEY, toB64(sql.export()));
    sql.exec('PRAGMA foreign_keys = ON');
  })();

  window.DermAPI = async function (method, path, body) {
    await ready;
    const out = await app.handle(method, path, body ? JSON.parse(JSON.stringify(body)) : null, store.get(TOKEN_KEY));
    if (out.token) store.set(TOKEN_KEY, out.token);
    else if (out.token === null) store.del(TOKEN_KEY);
    if (method !== 'GET') {
      store.set(DB_KEY, toB64(sql.export()));
      sql.exec('PRAGMA foreign_keys = ON');
    }
    return { status: out.status, body: out.body };
  };
  window.DermAPI.ready = ready;
})();
