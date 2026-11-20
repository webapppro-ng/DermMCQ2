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
`NODE_ENV=production` (marks the session cookie `Secure`; serve over HTTPS), `ADMIN_EMAILS`
(comma-separated emails that become administrators when they sign up or log in).

On first start the empty question bank is loaded from `db/questions.json`. From then on the database is the
source of truth: edits made in the admin dashboard are kept across restarts.

## Data model (`db/schema.sql`)

| Table       | Purpose |
|-------------|---------|
| `topics`    | The 15 question areas |
| `questions` | `stem_html` and `explanation_html` (rich text), `option_a`…`option_e`, `correct_option` (`A`–`E`), `topic_id`; `stem` and `explanation` keep the same content as plain text for search, previews and matching |
| `users`     | Email, name, scrypt password hash, `is_admin` |
| `sessions`  | Login tokens (HTTP-only cookie, 30 days) |
| `answers`   | One row per user per question: selected option and whether it was correct |
| `flags`     | Questions a user has flagged for review, with an optional note |
| `redo_attempts` | Latest re-attempt at each question a user first answered incorrectly |
| `images`    | Images uploaded in the admin dashboard, served at `/media/<id>` |

## Question bank

`db/questions.json` holds 507 single-best-answer questions imported from the author's Word document
(307 practice questions plus two 100-question papers), each with its correct answer and explanation,
grouped into the 15 topics.

Any question can be flagged for review, before or after answering, with an optional note. The main topics
page shows how many questions are flagged and opens a reviewer that steps through them one at a time
(Previous/Next or the arrow keys), revealing the answer and explanation.

The topics page also has a "Redo incorrect answers" option. It serves the questions a user got wrong, from all
topics or one topic. A question leaves the list once it is answered correctly; answered wrongly again, it
moves to the back of the queue. The first attempt stays the recorded score on the Performance page.

Each question's `source` field in `db/questions.json` records where it came from in the document
(`PQ.12` = practice question 12, `P1.5` / `P2.5` = question 5 of paper 1 / paper 2). Explanations store
one point per line and are shown as a bulleted list.

Psychodermatology and Dressings & Wound Care currently have no questions; they appear in the app as
"No questions yet" until questions are added.

## SQL seed file

`db/seed/dermmcq-seed.sql` is a standalone SQL snapshot of the question bank: the schema plus every topic
and question, in plain and rich text, and the images they embed (no users, answers or flags). Use it to create a database whenever one is needed:

```sh
npm run db:seed                  # create data/dermmcq.sqlite from the seed file
npm run db:seed -- --fresh       # replace an existing database (deletes its users and progress)
npm run db:seed -- --file db/seed/dermmcq-seed.sql --db path/to/other.sqlite
sqlite3 data/dermmcq.sqlite < db/seed/dermmcq-seed.sql   # same thing with the sqlite3 CLI
```

After changing questions, regenerate the snapshot from the database with `npm run db:export` (or
`npm run db:export -- path/to/db.sqlite path/to/out.sql`). If no database exists yet, the export builds
the bank from `db/questions.json`.

Run `npm run db:export` after editing questions in the admin dashboard to keep the snapshot current.

## Admin dashboard

Administrators see an **Admin** link in the menu. It opens the question bank: every question with search,
a topic filter and (on the server) sorting by most flagged or most answered. Each question can be edited —
topic, stem, the five options, which option is correct, and the explanation — and questions can be added
or deleted.

The stem and explanation are rich text, edited with [Quill](https://quilljs.com): headings, bold, italic,
underline, strikethrough, sub/superscript, numbered and bulleted lists, quotes, links and images. Images are
added with the toolbar button or by pasting or dropping them into the editor; the browser scales them to
at most 1600px on the longest side before upload (GIFs are kept as they are, up to 3 MB). On the server they
are stored in the `images` table and embedded as `/media/<id>`; on the hosted page they go to the page's
asset store; in the browser-only build they are kept inline.

Rich text is sanitized against one allowlist (`public/rich.js`) when it is saved — with
[sanitize-html](https://github.com/apostrophecms/sanitize-html) on the server and
[DOMPurify](https://github.com/cure53/DOMPurify) in the browser — and again with DOMPurify whenever it is
displayed. Only formatting tags, `http(s)`/`mailto` links (opened in a new tab with `noopener`) and PNG,
JPEG, GIF or WebP images are kept; scripts, styles, event handlers, iframes and SVG are removed. Questions
stored before rich text was added are converted automatically (explanation lines become a bulleted list).
`db/questions.json` may carry optional `stemHtml` / `explanationHtml` fields alongside the plain text. Changing the correct option re-marks users' existing answers and redo
attempts for that question against the new key. Only administrators can open the dashboard or call the
`/api/admin/*` routes; everyone else gets a 403.

Making someone an administrator (they must have signed up first):

```sh
npm run admin -- grant you@example.com
npm run admin -- revoke someone@example.com
npm run admin -- list
ADMIN_EMAILS=you@example.com npm start    # or promote automatically at sign-up / log-in
```

In the hosted page the page's owner is the administrator. Their edits are saved to the page's shared
storage and reach other viewers the next time they open it.

## Loading changes from `db/questions.json`

`npm run db:sync` makes an existing database match `db/questions.json`: new topics and questions are
added, matching questions are updated, and questions not in the file are deleted along with users'
answers to them. A question is matched by its stem plus first option. This overwrites admin-dashboard
edits to questions that are also in the file, so use either the dashboard or the file as the place you
edit questions.

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
| GET  | `/api/redo/:scope/next` | Next incorrectly answered question to redo; `scope` is `all` or a topic slug |
| POST | `/api/redo/answer` | `{questionId, selected}` → correctness, explanation and the updated redo counts |
| GET  | `/api/admin/questions` | Admin: every question with topic, options, answer, explanation and answer/flag counts |
| POST | `/api/admin/questions` | Admin: add a question `{topic, stemHtml, options[5], answer, explanationHtml}` (plain `stem` / `explanation` also accepted) |
| PUT  | `/api/admin/questions/:id` | Admin: save all fields of a question; re-marks answers if the key changes |
| DELETE | `/api/admin/questions/:id` | Admin: delete a question with its answers, flags and redo attempts |
| POST | `/api/admin/images` | Admin: `{dataUrl}` (PNG, JPEG, GIF or WebP, under 3 MB) → `{url}` to embed |
| GET  | `/media/:id` | An uploaded image |

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
