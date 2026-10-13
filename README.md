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
cp .env.example .env   # set OPENAI_API_KEY (and/or ANTHROPIC_API_KEY) and APP_PASSWORD
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
| `OPENAI_REASONING_EFFORT` | Optional, reasoning models only (`minimal`/`low`/`medium`/`high`). |
| `APP_PASSWORD` | Shared team password (browser login prompt; any username works). Leave unset only for local use. |
| `DATA_DIR` | Where the SQLite database lives (default `./data`). Use a persistent volume in production. |
| `CLAUDE_MODEL` | Default `claude-opus-5-5` (steps running on Claude only). |
| `GENERATION_EFFORT` | Claude effort for replies: `low` / `medium` (default) / `high`. |
| `CORPUS_EXCERPTS` | Klaff passages retrieved per objection (default 6). |

**Deploying:** the `Dockerfile` runs the app with the database on a `/data` volume. On Railway or similar, attach a volume at `/data` and set the variables above. Without a persistent volume, clients and saved replies are lost on each redeploy.

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

- **Client store** (`src/db.ts`, SQLite): name, alternate spellings, company, service type, target audience, tone, formality, phrasing do's and don'ts, sample messages, optional booking link. Matching uses the name and the alternate spellings, so add any variant that shows up on LinkedIn.
- **If the name doesn't match** (or two clients are equally close), the app doesn't guess. It asks you to pick the client from the dropdown. Every extracted field stays editable before you regenerate, and **Type the objection instead** skips the screenshot entirely.
- **Klaff corpus** (`corpus/`, plus uploads on the **Klaff Library** tab):
  - `core-klaff-style-playbook.md` is sent with every request. It distills the cold-outreach course, *Pitch Anything* and *Flip the Script* into working rules, written in our own words (frames, status, prizing, intrigue, push-pull, no-neediness, anti-bot tells, an objection-reading table, and industry lingo banks).
  - `klaff-sales-outreach-training-transcripts.md` is the cleaned course transcripts (timestamps stripped, duplicate section removed). It's chunked and searched with BM25, and the most relevant passages are included for each objection.
  - Any file in `corpus/` whose name starts with `core-` is always included. Other files are retrieved by relevance. Files are synced into the database on startup.
- **Generation** (`src/ai/generate.ts` builds the prompt; `src/ai/openai.ts` or the Claude call sends it): structured output guarantees exactly the three options plus a one-line read of the objection and a recommended pick. The same prompts, playbook and retrieval feed either provider, and the server logs which provider handles each step at startup (`src/ai/providers.ts`).

### Adding more Klaff material

- **Quick:** upload a `.docx`, `.md` or `.txt` on the Klaff Library tab. It's searchable immediately.
- **Permanent (version-controlled):** `npm run corpus:import -- path/to/file.docx`, which writes a cleaned markdown file into `corpus/`. Commit it.

## Development

```bash
npm test          # unit + API tests (LLMs are stubbed, no API key needed)
npm run typecheck
npm run dev       # restarts on file changes
```

```
src/server.ts            entry point
src/app.ts               Express routes (clients, favorites, analyze, generate, corpus)
src/db.ts                SQLite store
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
