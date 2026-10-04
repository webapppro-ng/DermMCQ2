# DermMCQ

A dermatology multiple-choice question bank. Users sign up for free, pick one of 16 topics, and work through
their unanswered questions one at a time. Each answer shows the correct option and an explanation. A
performance page shows questions answered and percentage correct, overall and per topic.

## Run it

Requires Node 22.13 or later (uses the built-in `node:sqlite`).

```sh
npm install
npm start            # http://localhost:3000
```

Environment variables: `PORT` (default 3000), `DB_FILE` (default `data/dermmcq.sqlite`),
`NODE_ENV=production` (marks the session cookie `Secure`; serve over HTTPS).

The database is created and seeded from `db/questions.json` on first start.

## Data model (`db/schema.sql`)

| Table       | Purpose |
|-------------|---------|
| `topics`    | The 16 question areas |
| `questions` | `stem`, `option_a`…`option_e`, `correct_option` (`A`–`E`), `explanation`, `topic_id` |
| `users`     | Email, name, scrypt password hash |
| `sessions`  | Login tokens (HTTP-only cookie, 30 days) |
| `answers`   | One row per user per question: selected option and whether it was correct |

## Adding questions

Add entries to `db/questions.json` under the right topic (exactly five options, `answer` is a letter A–E),
then delete `data/dermmcq.sqlite` to reseed, or insert rows directly into the `questions` table.

## API

| Method | Path | |
|--------|------|-|
| POST | `/api/signup` | `{name, email, password}` |
| POST | `/api/login` | `{email, password}` |
| POST | `/api/logout` | |
| GET  | `/api/me` | Current user or `null` |
| GET  | `/api/topics` | Topics with total / answered / correct for the user |
| GET  | `/api/topics/:slug/next` | Next unanswered question (answer withheld) |
| POST | `/api/answer` | `{questionId, selected}` → correctness and explanation |
| POST | `/api/topics/:slug/reset` | Clear the user's answers for one topic |
| GET  | `/api/stats` | Overall and per-topic performance |

All routes live in `src/core.js`, which is written against a small SQL adapter so the same code runs on
the server and in the browser prototype.

## Browser prototype

`npm run build:prototype` writes `dist/dermmcq.html`, a single file that runs the same schema and routes in
the browser using sql.js (SQLite compiled to JavaScript). Data is kept in that browser's localStorage, so it
is for demonstration only; deploy the Node server for real, shared accounts.
