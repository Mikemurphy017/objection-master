# Objection Master Pro

Internal tool for Bluestone Partners / TextTonality. Drop in a screenshot of a LinkedIn objection and get back three ready-to-send replies in Oren Klaff's style, tuned to that client's voice and service type.

**User flow:** upload (or paste) a screenshot → the app reads the objection and the client's name → matches the client on file → writes three options:

1. **Move to an intro call**: steers toward booking an introductory call
2. **Leave the door open**: keeps it warm with no push, so they can re-engage later
3. **Continue the conversation**: industry lingo plus a question that moves it forward

Star any reply to save it to that client's library. Saved replies show up whenever you handle that client again, and they're fed back into generation as examples of the client's voice.

## Running it

Requires Node 22.18+ (runs the TypeScript directly, no build step).

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY (and/or ANTHROPIC_API_KEY)
node --env-file=.env --disable-warning=ExperimentalWarning src/server.ts
# or: export the variables and run `npm start`
```

Open http://localhost:3000, add a client on the **Clients** tab, then go to **Respond** and drop a screenshot.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | When set, OpenAI writes the three replies. With no Anthropic key, OpenAI reads the screenshots too. |
| `ANTHROPIC_API_KEY` | Optional. When set, Claude reads the screenshots (and writes replies if there's no OpenAI key). |
| `GENERATION_PROVIDER` / `EXTRACTION_PROVIDER` | Force a provider per step: `openai` or `anthropic`. |
| `OPENAI_MODEL` | Default `gpt-5`. If OpenAI also reads screenshots, the model needs vision and structured outputs. |
| `OPENAI_REASONING_EFFORT` | Optional. Reasoning models (gpt-5, o-series) default to `low` for replies and `minimal` for screenshots, with low verbosity, for fast replies. |
| `ADMIN_EMAIL` | The one account that can open `/admin` and manage access. Default `mike@bluestonepartnersllc.com`. |
| `ADMIN_PASSWORD` | Optional. Sets the owner's first password. Without it, the server log prints a one-time setup link on first start. |
| `DATABASE_URL` | Postgres connection string. When set, all data (clients, chat turns, saved replies, corpus) lives in Postgres instead of SQLite. See **Storage** below. |
| `PGSSLMODE` | Optional Postgres SSL override: `disable`, `require`/`no-verify` (encrypt, skip cert check) or `verify-full`. A `sslmode=` in the URL wins. |
| `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION` | S3-compatible bucket for screenshots (the names Railway Buckets expose). `S3_*`/`AWS_*` equivalents also work; see **Storage**. |
| `DATA_DIR` | Fallback storage when the above aren't set: the SQLite file and `uploads/` screenshots (default `./data`). |
| `CLAUDE_MODEL` | Default `claude-opus-5-5` (steps running on Claude only). |
| `GENERATION_EFFORT` | Claude effort for replies: `low` (default, fastest) / `medium` / `high`. |
| `CORPUS_EXCERPTS` | Klaff passages retrieved per objection (default 6). |

### Storage

| What | Default (local dev, tests) | Production |
|---|---|---|
| Clients, chat turns, saved replies, Klaff corpus | SQLite at `$DATA_DIR/objection-master.db` | Postgres, when `DATABASE_URL` is set |
| Screenshots | Files in `$DATA_DIR/uploads/` | S3-compatible bucket, when a bucket is configured |

The server logs which storage it picked at startup (no secrets), e.g. `Data: Postgres at postgres.railway.internal:5432/railway (SSL off). Screenshots: bucket "shots-ab12cd" at t3.storageapi.dev.`

- **Postgres** (`src/db-postgres.ts`): tables are created on startup if missing (`CREATE TABLE IF NOT EXISTS`), so a fresh database needs no setup. SSL is picked from `sslmode` in the URL, then `PGSSLMODE`, then automatically: off for `localhost`, single-word hosts and Railway's private `*.railway.internal` hostname; on without certificate verification for anything else (which is what Railway's public `*.proxy.rlwy.net` URL needs). Existing SQLite data is not copied over.
- **Bucket** (`src/images.ts`): screenshots are stored under `screenshots/<id>` (override with `S3_PREFIX`) and streamed back through the app's own password-protected `/api/images/:id`, so the bucket stays private. The bucket name plus both keys are required; endpoint and region are optional (region defaults to `auto`). Accepted names, first match wins:

  | Setting | Variables |
  |---|---|
  | Bucket | `S3_BUCKET`, `BUCKET_NAME`, `AWS_S3_BUCKET_NAME`, `BUCKET` |
  | Endpoint | `S3_ENDPOINT`, `BUCKET_ENDPOINT`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, `ENDPOINT` |
  | Access key id | `S3_ACCESS_KEY_ID`, `BUCKET_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID`, `ACCESS_KEY_ID` |
  | Secret key | `S3_SECRET_ACCESS_KEY`, `BUCKET_SECRET_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`, `SECRET_ACCESS_KEY` |
  | Region | `S3_REGION`, `BUCKET_REGION`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `REGION` |
  | Path-style URLs | `S3_FORCE_PATH_STYLE=true` (only for older Railway buckets whose Credentials tab says so) |

**Deploying on Railway:** on the app service, add variable references to the Postgres service (`DATABASE_URL=${{Postgres.DATABASE_URL}}`, the private URL; use your actual service names) and to the bucket (`BUCKET=${{Bucket.BUCKET}}`, and likewise `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`; or use the bucket's "AWS SDK" auto-inject preset). With both set, nothing is written to disk, so no volume or `DATA_DIR` is needed. Without them the `Dockerfile` falls back to SQLite and files under `/data`, which needs a volume mounted at `/data` or everything is lost on redeploy.

### Importing clients from a CSV

On **Manage clients**, click **Import CSV** (or drop a CSV onto the page). You get a preview before anything is saved.

- **Columns** are matched by header name, case and punctuation ignored: Name / Client Name / Full Name (or First Name + Last Name), Other names / AKA (separate several with `;`), Company / Firm, Country / Location / Based in, Service type / Industry, Target audience / ICP / Niche, Tone, Formality, Style notes / Notes, Sample messages, Booking link / Calendly. Unrecognised columns are shown and ignored. A template is downloadable from the dialog.
- **Blanks stay blank.** Anything the file doesn't provide is left empty, and clients missing country, service type, target audience, tone or style notes are flagged **Needs details** for account managers (with a filter and a "Still to fill in" note on the client form).
- **No duplicates, no overwrites.** Clients already on file are matched with the same fuzzy rules as screenshots (nicknames, middle initials, stored aliases) and skipped; optionally the import fills in only their empty fields. Rows without a name, and names listed twice in the file, are skipped and shown in the preview.
- Comma-, semicolon- and tab-separated files, quoted cells with commas or line breaks, and Excel's Windows-1252 encoding all work.

### Accounts and access

Everyone signs in with their own email and password; there are no public pages except sign-in.

- **Owner:** `ADMIN_EMAIL` (Mike). On first start, if the owner has no password, the server log prints a one-time setup link (`First-time setup for ...: open <app URL>/invite#...`, valid 7 days), unless `ADMIN_PASSWORD` is set.
- **Admin page (`/admin`, owner only):** invite people (creates a one-time link to copy or email; valid 7 days), issue a fresh invite or a password-reset link (valid 2 days), disable access (signs them out immediately), re-enable, or remove someone. Nothing is emailed automatically.
- **Everyone:** "Change password" and "Sign out" sit at the bottom of the sidebar. Changing or resetting a password signs out the account's other devices.
- **Under the hood:** passwords are hashed with scrypt; sessions are random tokens in an HttpOnly, SameSite=Lax cookie (30 days), stored only as SHA-256 hashes in the `auth_tokens` table alongside invite and reset tokens. Failed sign-ins are throttled (10 per 15 minutes per email and IP).

## How it works

```
screenshot ──► vision model ──► objection text, client name, prospect, earlier messages
                                     │
                     fuzzy name match (nicknames, aliases, CFP®/ChFC suffixes stripped)
                                     │
client profile + saved favorites + core Klaff playbook + retrieved Klaff passages
                                     │
                 OpenAI (or Claude) ──► 3 replies (structured JSON), one per goal
```

- **Client store** (`src/db.ts`; SQLite locally, Postgres in production): name, alternate spellings, company, service type, target audience, tone, formality, phrasing do's and don'ts, sample messages, optional booking link. Matching uses the name and the alternate spellings, so add any variant that shows up on LinkedIn.
- **If the name doesn't match** (or two clients are equally close), the app doesn't guess. It asks you to pick the client from the dropdown. Every extracted field stays editable before you regenerate, and **Type the objection instead** skips the screenshot entirely.
- **Klaff corpus** (`corpus/`, plus uploads on the **Klaff Library** tab):
  - `core-texttonality-framework.md` is sent with every request and governs tone, length and formatting (2 to 3 short lines, one idea, spaced lines, no em dashes, tone by lead status, banned AI-sounding phrases). Where it and the Klaff material disagree, TextTonality wins.
  - `core-house-reply-examples.md` is sent with every request: the team's real replies, grouped by objection, with the house moves they share (casual opener, the fork question, "would you be opposed to a quick intro call?", not replacing their advisor or CPA, worst case / best case, one specific hook). They're the gold standard for voice; add new winners here.
  - `core-klaff-style-playbook.md` is sent with every request. It distills the cold-outreach course, *Pitch Anything* and *Flip the Script* into working rules, written in our own words (frames, status, prizing, intrigue, push-pull, no-neediness, anti-bot tells, an objection-reading table, and industry lingo banks).
  - `klaff-sales-outreach-training-transcripts.md` is the cleaned course transcripts (timestamps stripped, duplicate section removed). It's chunked and searched with BM25, and the most relevant passages are included for each objection.
  - Any file in `corpus/` whose name starts with `core-` is always included. Other files are retrieved by relevance. Files are synced into the database on startup.
- **Generation** (`src/ai/generate.ts` builds the prompt; `src/ai/openai.ts` or the Claude call sends it): structured output guarantees exactly the three options plus a one-line read of the objection and a recommended pick. The same prompts, playbook and retrieval feed either provider, and the server logs which provider handles each step at startup (`src/ai/providers.ts`).

### Adding more Klaff material

- **Quick:** upload a `.docx`, `.md` or `.txt` on the Klaff Library tab. It's searchable immediately.
- **Permanent (version-controlled):** `npm run corpus:import -- path/to/file.docx`, which writes a cleaned markdown file into `corpus/`. Commit it.

## Development

```bash
npm test          # unit + API tests (LLMs and S3 are stubbed, no API key or services needed)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/om_test npm test   # also run the store + API tests on Postgres
npm run typecheck
npm run dev       # restarts on file changes
```

```
src/server.ts            entry point
src/app.ts               Express routes (clients, favorites, analyze, generate, corpus)
src/storage.ts           picks Postgres/SQLite and bucket/filesystem from the environment
src/db.ts                Store interface, shared types, SQLite store
src/db-postgres.ts       Postgres store
src/images.ts            screenshot storage (filesystem or S3 bucket)
src/match.ts             client-name matching
src/ai/providers.ts      picks OpenAI or Claude per step
src/ai/openai.ts         OpenAI (Responses API) screenshot reading + generation
src/ai/extract.ts        screenshot prompt/schema + Claude screenshot reading
src/ai/generate.ts       reply prompt/schema + Claude generation
src/corpus/ingest.ts     docx/md/txt parsing and transcript cleanup
src/corpus/retrieval.ts  BM25 retrieval
public/                  the web UI (plain HTML/CSS/JS)
corpus/                  Klaff source material
```
