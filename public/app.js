(function () {
  'use strict';

  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  const state = { user: null, view: 'auth', topic: null, authTab: 'login' };

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
    for (const v of ['topics', 'performance']) {
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
    if (t.answered === 0) return `<span class="topic-pill pill-new">${t.total} new</span>`;
    if (t.answered >= t.total) return `<span class="topic-pill pill-done">Done · ${pctText(pct(t.correct, t.answered))}</span>`;
    return `<span class="topic-pill pill-going">${t.total - t.answered} left</span>`;
  }

  async function renderTopics() {
    const { topics } = await api('GET', '/api/topics');
    const answered = topics.reduce((n, t) => n + t.answered, 0);
    const total = topics.reduce((n, t) => n + t.total, 0);
    const correct = topics.reduce((n, t) => n + t.correct, 0);
    app.innerHTML = `
      <div>
        <p class="eyebrow">Welcome back, ${esc(state.user.name)}</p>
        <h1>Choose a topic</h1>
        <p class="lede">Each topic serves your unanswered questions in order. Pick up where you left off at any time.</p>
      </div>
      <div class="summary-strip">
        <div><strong class="num">${answered}<span class="muted" style="font-size:1rem"> / ${total}</span></strong><span>questions answered</span></div>
        <div><strong class="num">${pctText(pct(correct, answered))}</strong><span>correct overall</span></div>
      </div>
      <ul class="topic-list">
        ${topics.map((t) => `
          <li>
            <button class="topic" type="button" data-slug="${esc(t.slug)}">
              <span class="topic-name">${esc(t.name)}</span>
              ${pill(t)}
              <span class="topic-meta num">${t.answered} of ${t.total} answered${t.answered ? ` · ${pctText(pct(t.correct, t.answered))} correct` : ''}</span>
              <span class="bar" aria-hidden="true"><i style="width:${t.total ? (t.answered / t.total) * 100 : 0}%"></i></span>
            </button>
          </li>`).join('')}
      </ul>`;
    app.querySelectorAll('.topic').forEach((b) => (b.onclick = () => go('quiz', b.dataset.slug)));
  }

  /* ---------- Quiz ---------- */
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
        <div class="bar" aria-hidden="true" style="margin-top:10px"><i style="width:${(progress.answered / progress.total) * 100}%"></i></div>
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
        <div class="row">
          <button class="btn btn-primary" type="button" id="submit" disabled>Submit answer</button>
        </div>
      </section>`;
    document.getElementById('back').onclick = () => go('topics');
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
          <p>${esc(result.explanation)}</p>
        </div>`;
      const isLast = progress.answered + 1 >= progress.total;
      submit.textContent = isLast ? 'Finish topic' : 'Next question';
      submit.disabled = false;
      submit.onclick = () => go('quiz');
      submit.focus();
    };
  }

  /* ---------- Performance ---------- */
  async function renderPerformance() {
    const { overall, topics } = await api('GET', '/api/stats');
    const p = pct(overall.correct, overall.answered);
    const done = topics.filter((t) => t.answered >= t.total && t.total > 0).length;
    const scoreCell = (t) => {
      const v = pct(t.correct, t.answered);
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
  document.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => state.user && go(b.dataset.nav)));
  document.getElementById('logout').onclick = async () => {
    await api('POST', '/api/logout');
    state.user = null;
    state.authTab = 'login';
    go('auth');
  };

  (async function boot() {
    try {
      await window.DermAPI.ready;
      const { user } = await api('GET', '/api/me');
      state.user = user;
      go(user ? 'topics' : 'auth');
    } catch (err) {
      app.innerHTML = `<p class="error">The question bank could not load: ${esc(err.message)}. Reload the page to try again.</p>`;
    }
  })();
})();
