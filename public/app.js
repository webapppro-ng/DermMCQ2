(function () {
  'use strict';

  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  const state = { user: null, view: 'auth', topic: null, authTab: 'login', flags: [], flagIndex: 0, revealed: new Set() };
  const FLAG_ICON = '<svg class="flag-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 15V1.5M3 2h9l-2 3.5L12 9H3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (correct, answered) => (answered ? Math.round((correct / answered) * 100) : null);
  const pctText = (p) => (p === null ? '–' : p + '%');

  async function api(method, path, body) {
    const res = await window.DermAPI(method, path, body);
    if (res.status === 401 && path !== '/api/login') {
      state.user = null;
      go('auth');
      throw new Error(res.body.error);
    }
    if (res.status >= 400) throw new Error(res.body.error || 'Something went wrong. Try again.');
    return res.body;
  }

  function go(view, topic) {
    state.view = view;
    if (topic !== undefined) state.topic = topic;
    render().catch((err) => {
      app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    });
    window.scrollTo(0, 0);
  }

  function updateNav() {
    nav.hidden = !state.user;
    if (!state.user) return;
    document.getElementById('nav-user').textContent = state.user.name;
    for (const v of ['topics', 'flagged', 'performance']) {
      const el = document.getElementById('nav-' + v);
      if (state.view === v) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }

  async function render() {
    if (!state.user && state.view !== 'auth') state.view = 'auth';
    updateNav();
    if (state.view === 'auth') return renderAuth();
    if (state.view === 'topics') return renderTopics();
    if (state.view === 'quiz') return renderQuiz();
    if (state.view === 'performance') return renderPerformance();
    if (state.view === 'flagged') return renderFlagged();
  }

  /* ---------- Auth ---------- */
  const TOPIC_NAMES = [
    'Cutaneous Allergy', 'Dermatopathology', 'Dermoscopy', 'Dressings & Wound Care',
    'Formulary & Systemic Therapy', 'General Dermatology', 'Genito-urinary & Oral Medicine',
    'Infectious Disease', 'Paediatrics & Genetics', 'Photodermatology', 'Psychodermatology',
    'Skin Biology & Research', 'Skin of Colour', 'Skin Oncology', 'Skin Surgery & Cosmetic Dermatology',
  ];

  function renderAuth() {
    const signup = state.authTab === 'signup';
    app.innerHTML = `
      <section class="auth">
        <div class="auth-intro">
          <p class="eyebrow">Dermatology question bank</p>
          <h1>Single best answer practice across 15 dermatology topics</h1>
          <p class="lede">Work through each topic one question at a time. Every answer comes with an explanation, and your performance page tracks your score by topic. Accounts are free.</p>
          <div class="topic-cloud">${TOPIC_NAMES.map((n) => `<span>${esc(n)}</span>`).join('')}</div>
        </div>
        <div class="card">
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" id="tab-login" aria-selected="${!signup}">Log in</button>
            <button class="tab" role="tab" id="tab-signup" aria-selected="${signup}">Sign up free</button>
          </div>
          <form class="form" id="auth-form" novalidate>
            ${signup ? `<div class="field"><label for="f-name">Name</label><input id="f-name" name="name" autocomplete="name" required></div>` : ''}
            <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required></div>
            <div class="field">
              <label for="f-password">Password</label>
              <input id="f-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
              ${signup ? '<span class="hint">At least 8 characters.</span>' : ''}
            </div>
            <p class="error" id="auth-error" hidden></p>
            <button class="btn btn-primary" type="submit">${signup ? 'Create account' : 'Log in'}</button>
          </form>
        </div>
      </section>`;
    document.getElementById('tab-login').onclick = () => { state.authTab = 'login'; renderAuth(); };
    document.getElementById('tab-signup').onclick = () => { state.authTab = 'signup'; renderAuth(); };
    document.getElementById('auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      const errEl = document.getElementById('auth-error');
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const out = await api('POST', signup ? '/api/signup' : '/api/login', data);
        state.user = out.user;
        go('topics');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
      }
    };
  }

  /* ---------- Topics ---------- */
  function pill(t) {
    if (t.total === 0) return `<span class="topic-pill pill-empty">No questions yet</span>`;
    if (t.answered === 0) return `<span class="topic-pill pill-new">${t.total} new</span>`;
    if (t.answered >= t.total) return `<span class="topic-pill pill-done">Done · ${pctText(pct(t.correct, t.answered))}</span>`;
    return `<span class="topic-pill pill-going">${t.total - t.answered} left</span>`;
  }

  async function renderTopics() {
    const { topics, flagged } = await api('GET', '/api/topics');
    const answered = topics.reduce((n, t) => n + t.answered, 0);
    const total = topics.reduce((n, t) => n + t.total, 0);
    const correct = topics.reduce((n, t) => n + t.correct, 0);
    app.innerHTML = `
      <div>
        <p class="eyebrow">Welcome back${state.user.name ? ', ' + esc(state.user.name) : ''}</p>
        <h1>Choose a topic</h1>
        <p class="lede">Each topic serves your unanswered questions in order. Pick up where you left off at any time.</p>
      </div>
      <div class="summary-strip">
        <div><strong class="num">${answered}<span class="muted" style="font-size:1rem"> / ${total}</span></strong><span>questions answered</span></div>
        <div><strong class="num">${pctText(pct(correct, answered))}</strong><span>correct overall</span></div>
      </div>
      ${flagged
        ? `<button class="flag-panel" type="button" id="open-flags">
             ${FLAG_ICON}
             <span class="flag-panel-text"><strong>Flagged for review</strong>
               <span class="num">${flagged} question${flagged === 1 ? '' : 's'} saved to go back over</span></span>
             <span class="flag-panel-go">Review →</span>
           </button>`
        : `<div class="flag-panel is-empty">${FLAG_ICON}
             <span class="flag-panel-text"><strong>Flagged for review</strong>
               <span>Use the “Flag for review” button on any question and it will be collected here.</span></span>
           </div>`}
      <ul class="topic-list">
        ${topics.map((t) => `
          <li>
            <button class="topic" type="button" data-slug="${esc(t.slug)}"${t.total ? '' : ' disabled'}>
              <span class="topic-name">${esc(t.name)}</span>
              ${pill(t)}
              <span class="topic-meta num">${t.answered} of ${t.total} answered${t.answered ? ` · ${pctText(pct(t.correct, t.answered))} correct` : ''}</span>
              <span class="bar" aria-hidden="true"><i style="width:${t.total ? (t.answered / t.total) * 100 : 0}%"></i></span>
            </button>
          </li>`).join('')}
      </ul>`;
    app.querySelectorAll('.topic').forEach((b) => (b.onclick = () => go('quiz', b.dataset.slug)));
    const open = document.getElementById('open-flags');
    if (open) open.onclick = () => { state.flagIndex = 0; go('flagged'); };
  }

  /* ---------- Quiz ---------- */
  // Explanations are stored one point per line; show several points as a list.
  function explanationHtml(text) {
    const points = String(text).split('\n').map((s) => s.trim()).filter(Boolean);
    if (points.length < 2) return `<p>${esc(points[0] || '')}</p>`;
    return `<ul class="points">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  }

  async function renderQuiz() {
    const data = await api('GET', `/api/topics/${encodeURIComponent(state.topic)}/next`);
    const { topic, progress, question } = data;
    const head = (label) => `
      <div>
        <button class="back" type="button" id="back">← All topics</button>
        <div class="quiz-head">
          <h2>${esc(topic.name)}</h2>
          <span class="eyebrow num">${label}</span>
        </div>
        <div class="bar" aria-hidden="true" style="margin-top:10px"><i style="width:${progress.total ? (progress.answered / progress.total) * 100 : 0}%"></i></div>
      </div>`;

    if (!question) {
      const p = pct(progress.correct, progress.answered);
      app.innerHTML = `
        <section class="quiz">
          ${head(`${progress.answered} of ${progress.total} answered`)}
          <div class="card done">
            <h2>Topic complete</h2>
            <p class="lede">You scored <strong class="num">${progress.correct} / ${progress.answered}</strong> (${pctText(p)}) in ${esc(topic.name)}.</p>
            <div class="row" style="margin-top:16px">
              <button class="btn btn-primary" type="button" id="to-topics">Choose another topic</button>
              <button class="btn btn-ghost" type="button" id="reset">Reset and retake this topic</button>
            </div>
            <p class="hint" id="reset-confirm" hidden></p>
          </div>
        </section>`;
      document.getElementById('back').onclick = () => go('topics');
      document.getElementById('to-topics').onclick = () => go('topics');
      const resetBtn = document.getElementById('reset');
      resetBtn.onclick = async () => {
        if (!resetBtn.dataset.armed) {
          resetBtn.dataset.armed = '1';
          resetBtn.textContent = 'Confirm reset';
          const c = document.getElementById('reset-confirm');
          c.textContent = 'This clears your answers for this topic only. Your other topics are unaffected.';
          c.hidden = false;
          return;
        }
        await api('POST', `/api/topics/${encodeURIComponent(topic.slug)}/reset`);
        go('quiz');
      };
      return;
    }

    let selected = null;
    app.innerHTML = `
      <section class="quiz">
        ${head(`Question ${progress.answered + 1} of ${progress.total}`)}
        <p class="stem">${esc(question.stem)}</p>
        <ul class="options" id="options">
          ${question.options.map((o) => `
            <li><button class="option" type="button" data-key="${o.key}" aria-pressed="false">
              <span class="key">${o.key}</span><span class="text">${esc(o.text)}</span><span class="tag"></span>
            </button></li>`).join('')}
        </ul>
        <div id="feedback"></div>
        <div class="row actions">
          <button class="btn btn-primary" type="button" id="submit" disabled>Submit answer</button>
          ${flagControlHtml(question)}
        </div>
        ${flagNoteHtml(question)}
      </section>`;
    document.getElementById('back').onclick = () => go('topics');
    wireFlag(question);
    const buttons = [...app.querySelectorAll('.option')];
    const submit = document.getElementById('submit');
    buttons.forEach((b) => {
      b.onclick = () => {
        selected = b.dataset.key;
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        submit.disabled = false;
      };
    });
    submit.onclick = async () => {
      submit.disabled = true;
      let result;
      try {
        result = await api('POST', '/api/answer', { questionId: question.id, selected });
      } catch (err) {
        document.getElementById('feedback').innerHTML = `<p class="error">${esc(err.message)}</p>`;
        submit.disabled = false;
        return;
      }
      buttons.forEach((b) => {
        b.disabled = true;
        b.setAttribute('aria-pressed', 'false');
        const k = b.dataset.key;
        if (k === result.correctOption) { b.classList.add('is-correct'); b.querySelector('.tag').textContent = 'Correct answer'; }
        else if (k === result.selected) { b.classList.add('is-wrong'); b.querySelector('.tag').textContent = 'Your answer'; }
      });
      document.getElementById('feedback').innerHTML = `
        <div class="explanation">
          <p class="verdict ${result.correct ? 'ok' : 'bad'}">${result.correct ? 'Correct' : `Incorrect. The answer is ${result.correctOption}.`}</p>
          ${explanationHtml(result.explanation)}
        </div>`;
      const isLast = progress.answered + 1 >= progress.total;
      submit.textContent = isLast ? 'Finish topic' : 'Next question';
      submit.disabled = false;
      submit.onclick = () => go('quiz');
      submit.focus();
    };
  }

  /* ---------- Flags ---------- */
  // In the reviewer every question is flagged, so the button there reads as an action: "Remove flag".
  function flagLabel(flagged) {
    return flagged ? (state.view === 'flagged' ? 'Remove flag' : 'Flagged for review') : 'Flag for review';
  }
  function flagControlHtml(q) {
    return `<button class="btn btn-flag" type="button" id="flag-toggle" aria-pressed="${q.flagged}">
      ${FLAG_ICON}<span>${flagLabel(q.flagged)}</span></button>`;
  }
  function flagNoteHtml(q) {
    return `<div class="flag-note" id="flag-note"${q.flagged ? '' : ' hidden'}>
      <label for="flag-note-input">Note for your review <span class="muted">(optional)</span></label>
      <div class="row">
        <input id="flag-note-input" maxlength="500" placeholder="e.g. Re-read the guideline on this" value="${esc(q.note || '')}">
        <span class="hint" id="flag-note-status" aria-live="polite"></span>
      </div>
    </div>`;
  }
  // Wires the flag button and note field; keeps q.flagged / q.note current and reports changes.
  function wireFlag(q, onChange) {
    const btn = document.getElementById('flag-toggle');
    const box = document.getElementById('flag-note');
    const input = document.getElementById('flag-note-input');
    const status = document.getElementById('flag-note-status');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const out = q.flagged
          ? await api('DELETE', `/api/flags/${q.id}`)
          : await api('PUT', `/api/flags/${q.id}`, { note: input.value });
        q.flagged = out.flagged; q.note = out.note;
        btn.setAttribute('aria-pressed', String(q.flagged));
        btn.querySelector('span').textContent = flagLabel(q.flagged);
        box.hidden = !q.flagged;
        status.textContent = '';
        if (!q.flagged) input.value = '';
        if (onChange) onChange(q);
      } catch (err) {
        status.textContent = err.message;
      }
      btn.disabled = false;
    };
    input.onchange = async () => {
      if (!q.flagged || input.value.trim() === (q.note || '')) return;
      try {
        const out = await api('PUT', `/api/flags/${q.id}`, { note: input.value });
        q.note = out.note;
        status.textContent = 'Note saved';
        if (onChange) onChange(q);
      } catch (err) {
        status.textContent = err.message;
      }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
  }

  async function renderFlagged() {
    const { questions } = await api('GET', '/api/flags');
    state.flags = questions;
    drawFlagged();
  }

  // Steps through flagged questions one at a time from the cached list.
  function drawFlagged() {
    const list = state.flags;
    if (!list.length) {
      app.innerHTML = `
        <section class="quiz">
          <div>
            <button class="back" type="button" id="back">← All topics</button>
            <h2>Flagged for review</h2>
          </div>
          <div class="card">
            <p class="lede" style="margin:0">You have no flagged questions. While answering, use “Flag for review” to save a question here with an optional note.</p>
            <div class="row" style="margin-top:16px"><button class="btn btn-primary" type="button" id="to-topics">Choose a topic</button></div>
          </div>
        </section>`;
      document.getElementById('back').onclick = () => go('topics');
      document.getElementById('to-topics').onclick = () => go('topics');
      return;
    }
    state.flagIndex = Math.max(0, Math.min(state.flagIndex, list.length - 1));
    const i = state.flagIndex;
    const q = list[i];
    const revealed = !!q.answer || state.revealed.has(q.id);
    const status = q.answer
      ? `<span class="chip ${q.answer.correct ? 'chip-ok' : 'chip-bad'}">You answered ${q.answer.selected} · ${q.answer.correct ? 'correct' : 'incorrect'}</span>`
      : '<span class="chip">Not answered yet</span>';
    app.innerHTML = `
      <section class="quiz">
        <div>
          <button class="back" type="button" id="back">← All topics</button>
          <div class="quiz-head">
            <h2>Flagged for review</h2>
            <span class="eyebrow num">${i + 1} of ${list.length}</span>
          </div>
          <div class="bar" aria-hidden="true" style="margin-top:10px"><i style="width:${((i + 1) / list.length) * 100}%"></i></div>
        </div>
        <div class="row review-meta"><span class="eyebrow">${esc(q.topic.name)}</span>${status}</div>
        <p class="stem">${esc(q.stem)}</p>
        <ul class="options">
          ${q.options.map((o) => {
            let cls = '', tag = '';
            if (revealed && o.key === q.correctOption) { cls = ' is-correct'; tag = 'Correct answer'; }
            else if (revealed && q.answer && o.key === q.answer.selected) { cls = ' is-wrong'; tag = 'Your answer'; }
            return `<li><div class="option${cls}"><span class="key">${o.key}</span><span class="text">${esc(o.text)}</span><span class="tag">${tag}</span></div></li>`;
          }).join('')}
        </ul>
        ${revealed
          ? `<div class="explanation"><p class="verdict">The answer is ${q.correctOption}</p>${explanationHtml(q.explanation)}</div>`
          : '<div class="row"><button class="btn btn-ghost" type="button" id="reveal">Show answer and explanation</button></div>'}
        ${flagNoteHtml(Object.assign({}, q, { flagged: true }))}
        <div class="row review-nav">
          <button class="btn btn-ghost" type="button" id="prev"${i === 0 ? ' disabled' : ''}>← Previous</button>
          <button class="btn btn-primary" type="button" id="next"${i === list.length - 1 ? ' disabled' : ''}>Next →</button>
          <span class="spacer"></span>
          ${flagControlHtml({ flagged: true })}
        </div>
        <p class="hint">Use the ← and → keys to move between flagged questions. Removing a flag takes the question off this list.</p>
      </section>`;
    document.getElementById('back').onclick = () => go('topics');
    document.getElementById('prev').onclick = () => stepFlag(-1);
    document.getElementById('next').onclick = () => stepFlag(1);
    const reveal = document.getElementById('reveal');
    if (reveal) reveal.onclick = () => { state.revealed.add(q.id); drawFlagged(); };
    const live = Object.assign({}, q, { flagged: true });
    wireFlag(live, (updated) => {
      q.note = updated.note;
      if (!updated.flagged) { state.flags.splice(i, 1); drawFlagged(); }
    });
  }

  function stepFlag(delta) {
    const next = state.flagIndex + delta;
    if (next < 0 || next >= state.flags.length) return;
    state.flagIndex = next;
    drawFlagged();
    window.scrollTo(0, 0);
  }

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'flagged' || e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') stepFlag(-1);
    if (e.key === 'ArrowRight') stepFlag(1);
  });

  /* ---------- Performance ---------- */
  async function renderPerformance() {
    const { overall, topics } = await api('GET', '/api/stats');
    const p = pct(overall.correct, overall.answered);
    const done = topics.filter((t) => t.answered >= t.total && t.total > 0).length;
    const scoreCell = (t) => {
      const v = pct(t.correct, t.answered);
      if (!t.total) return '<span class="muted">No questions yet</span>';
      if (v === null) return '<span class="muted">Not started</span>';
      const cls = v >= 70 ? 'score-hi' : v >= 50 ? 'score-mid' : 'score-lo';
      return `<span class="score"><span class="num">${v}%</span><span class="score-bar" aria-hidden="true"><i class="${cls}" style="width:${v}%"></i></span></span>`;
    };
    app.innerHTML = `
      <div>
        <p class="eyebrow">Performance</p>
        <h1>Your results</h1>
      </div>
      <div class="stat-row">
        <div class="stat"><strong class="num">${overall.answered}</strong><span>questions answered of ${overall.total}</span></div>
        <div class="stat"><strong class="num">${pctText(p)}</strong><span>correct overall (${overall.correct} of ${overall.answered})</span></div>
        <div class="stat"><strong class="num">${done} / ${topics.length}</strong><span>topics completed</span></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Topic</th><th class="n">Answered</th><th class="n">Correct</th><th class="n">Score</th></tr></thead>
          <tbody>
            ${topics.map((t) => `
              <tr>
                <td>${esc(t.name)}</td>
                <td class="n">${t.answered} / ${t.total}</td>
                <td class="n">${t.correct}</td>
                <td class="n">${scoreCell(t)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  /* ---------- Boot ---------- */
  document.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => {
    if (!state.user) return;
    if (b.dataset.nav === 'flagged') state.flagIndex = 0;
    go(b.dataset.nav);
  }));
  document.getElementById('logout').onclick = async () => {
    await api('POST', '/api/logout');
    state.user = null;
    state.authTab = 'login';
    go('auth');
  };

  (async function boot() {
    try {
      await window.DermAPI.ready;
      document.getElementById('logout').hidden = window.DermAPI.mode === 'shared';
      const { user } = await api('GET', '/api/me');
      state.user = user;
      go(user ? 'topics' : 'auth');
    } catch (err) {
      app.innerHTML = `<p class="error">The question bank could not load: ${esc(err.message)}. Reload the page to try again.</p>`;
    }
  })();
})();
