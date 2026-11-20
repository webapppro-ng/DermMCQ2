# Changelog

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
