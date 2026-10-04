// Builds dist/dermmcq.html: a single-file version of the app that runs SQLite in the browser (sql.js).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const between = (s, tag) => {
  const m = s.match(new RegExp(`<!-- ${tag}:start -->([\\s\\S]*?)<!-- ${tag}:end -->`));
  if (!m) throw new Error(`Missing ${tag} markers in index.html`);
  return m[1].trim();
};
const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;

const SQLJS_URL = process.env.SQLJS_URL || 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js';
const index = read('public/index.html');
const head = between(index, 'head').replace('<link rel="stylesheet" href="styles.css">', `<style>\n${read('public/styles.css')}\n</style>`);
const body = between(index, 'body');
const note = `<footer class="page" style="padding-top:0"><p class="notice" id="mode-note">Loading…</p></footer>`;

const html = [
  '<meta charset="utf-8">',
  head,
  body,
  note,
  `<script src="${SQLJS_URL}"></script>`,
  inlineScript(read('src/core.js')),
  inlineScript(`window.DERM_SCHEMA = ${JSON.stringify(read('db/schema.sql'))};\nwindow.DERM_SEED = ${read('db/questions.json')};`),
  inlineScript(read('scripts/prototype-api.js')),
  inlineScript(read('public/app.js')),
].join('\n');

const out = process.argv[2] || path.join(ROOT, 'dist', 'dermmcq.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
