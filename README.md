# DermMCQ

A dermatology multiple-choice question bank. Users sign up for free, pick one of 15 topics, and work through
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
| `topics`    | The 15 question areas |
| `questions` | `stem`, `option_a`…`option_e`, `correct_option` (`A`–`E`), `explanation`, `topic_id` |
| `users`     | Email, name, scrypt password hash |
| `sessions`  | Login tokens (HTTP-only cookie, 30 days) |
| `answers`   | One row per user per question: selected option and whether it was correct |
| `flags`     | Questions a user has flagged for review, with an optional note |

## Question bank

`db/questions.json` holds 507 single-best-answer questions imported from the author's Word document
(307 practice questions plus two 100-question papers), each with its correct answer and explanation,
grouped into the 15 topics.

Any question can be flagged for review, before or after answering, with an optional note. The main topics
page shows how many questions are flagged and opens a reviewer that steps through them one at a time
(Previous/Next or the arrow keys), revealing the answer and explanation. Each question's `source` field records where it came from in the document
(`PQ.12` = practice question 12, `P1.5` / `P2.5` = question 5 of paper 1 / paper 2). Explanations store
one point per line and are shown as a bulleted list.

Psychodermatology and Dressings & Wound Care currently have no questions; they appear in the app as
"No questions yet" until questions are added.

## SQL seed file

`db/seed/dermmcq-seed.sql` is a standalone SQL snapshot of the question bank: the schema plus every topic
and question (no users, answers or flags). Use it to create a database whenever one is needed:

```sh
npm run db:seed                  # create data/dermmcq.sqlite from the seed file
npm run db:seed -- --fresh       # replace an existing database (deletes its users and progress)
npm run db:seed -- --file db/seed/dermmcq-seed.sql --db path/to/other.sqlite
sqlite3 data/dermmcq.sqlite < db/seed/dermmcq-seed.sql   # same thing with the sqlite3 CLI
```

After changing questions, regenerate the snapshot from the database with `npm run db:export` (or
`npm run db:export -- path/to/db.sqlite path/to/out.sql`). If no database exists yet, the export builds
the bank from `db/questions.json`.

The server still syncs the database with `db/questions.json` every time it starts, so keep that file as the
place to edit questions and export the SQL file afterwards; otherwise edits made directly in the database
are overwritten from the JSON file on the next start.

## Adding or editing questions

Edit `db/questions.json` (exactly five options, `answer` is a letter A–E) and restart the server. On start
the database is synced with the file: new topics and questions are added, edited questions are updated in
place, and questions removed from the file are deleted along with users' answers to them. A question is
identified by its stem plus its first option, so users keep their answers when a question moves topic or
its explanation changes.

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
| PUT  | `/api/flags/:questionId` | Flag a question for review, or update its note: `{note?}` |
| DELETE | `/api/flags/:questionId` | Remove a flag |
| GET  | `/api/flags` | Flagged questions with answer, explanation, note and the user's own answer, newest first |

All routes live in `src/core.js`, which is written against a small SQL adapter so the same code runs on
the server and in the browser prototype.

## Browser prototype

`npm run build:prototype` writes `dist/dermmcq.html`, a single file that runs the same schema and routes in
the browser using sql.js (SQLite compiled to JavaScript).

- Hosted as a claude.ai artifact with the `db` and `user` capabilities, it runs in **shared mode**: viewers
  sign in with their claude.ai account and their answers are saved to a private per-user document in the
  artifact database (`data/users/<id>/progress`), so progress follows them across devices. Viewers need
  Contributor access to save progress.
- Anywhere else it runs in **local mode**: email/password accounts, with the SQLite file in localStorage.

Deploy the Node server for a public site with its own email/password sign-up.
