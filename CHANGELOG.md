# Changelog

## Unreleased

- Admin dashboard for administrators: browse, search and filter the question bank; edit any question's
  topic, stem, options, correct answer and explanation; add and delete questions. Changing an answer key
  re-marks existing answers. Server administrators are set with `npm run admin` or `ADMIN_EMAILS`; on the
  hosted page the owner is the administrator.
- Rich text question stems and explanations (`stem_html`, `explanation_html`), edited in the admin
  dashboard with a Quill editor: formatting, headings, lists, quotes, links and images. Images are resized in
  the browser and stored in the database (`images` table, `/media/<id>`), the hosted page's asset store, or
  inline in the browser-only build. All rich text is sanitized on save and on display. Existing questions are
  converted automatically.
- The question file now only fills an empty bank; the database is the source of truth afterwards so admin
  edits persist. `npm run db:sync` applies `db/questions.json` explicitly.

## Version 1 (1.0.0) — 2026-11-20

First complete version of DermMCQ.

- Free sign-up and login; passwords hashed, 30-day sessions.
- 15 topics and 507 single-best-answer questions imported from the author's question document
  (307 practice questions and two 100-question papers), each with answer and explanation.
- Topic practice that serves unanswered questions in order, with per-question explanations and
  per-topic reset.
- Performance page: questions answered and percentage correct, overall and per topic.
- Flag any question for review with an optional note, and step through flagged questions.
- Redo incorrectly answered questions from the dashboard, across all topics or one topic;
  first-attempt scores are kept on the Performance page.
- SQL seed file (`db/seed/dermmcq-seed.sql`) with `npm run db:seed` / `npm run db:export`.
- Hosted build on claude.ai: viewers sign in with their claude.ai account and progress, flags and
  redo attempts are saved per person.
