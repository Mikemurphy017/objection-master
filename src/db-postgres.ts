import pg from "pg";
import type { ParsedDocument } from "./corpus/ingest.ts";
import {
  chunkText,
  documentHash,
  sqlTimestamp,
  type Client,
  type ClientInput,
  type Conversation,
  type CorpusChunk,
  type CorpusDocument,
  type Favorite,
  type Store,
  type TokenKind,
  type Turn,
  type UpsertOptions,
  type User,
  type UserPatch,
  type UserRecord,
  publicUser,
  rowToUserRecord,
  userPatchEntries,
} from "./db.ts";

/**
 * Same tables and semantics as the SQLite schema. Timestamps are TIMESTAMPTZ and
 * are formatted back to SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) on the way out.
 * JSON columns use `json` (not `jsonb`) so stored key order is preserved.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  aliases JSON NOT NULL DEFAULT '[]',
  company TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  target_audience TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  formality TEXT NOT NULL DEFAULT '',
  style_notes TEXT NOT NULL DEFAULT '',
  sample_messages TEXT NOT NULL DEFAULT '',
  booking_link TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS generations (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  objection_text TEXT NOT NULL,
  prospect_name TEXT NOT NULL DEFAULT '',
  thread_context TEXT NOT NULL DEFAULT '',
  guidance TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  result JSON NOT NULL,
  sources JSON NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generations_client ON generations(client_id, created_at);
CREATE TABLE IF NOT EXISTS favorites (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  objection_text TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL,
  prospect_name TEXT NOT NULL DEFAULT '',
  generation_id INTEGER REFERENCES generations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS favorites_client ON favorites(client_id, created_at);
CREATE TABLE IF NOT EXISTS corpus_documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corpus_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES corpus_documents(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS corpus_chunks_document ON corpus_chunks(document_id, position);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id, kind);
`;

/** Arbitrary constant for pg_advisory_xact_lock, so parallel replicas don't race on CREATE TABLE. */
const SCHEMA_LOCK = 7_210_431;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Pool settings for a DATABASE_URL. SSL follows `sslmode` in the URL, else PGSSLMODE:
 * disable/allow → off; require/prefer/no-verify → on without certificate checks;
 * verify-ca/verify-full → on with checks. With neither set it is auto-detected:
 * off for localhost, single-label hosts and Railway's private `*.railway.internal`,
 * on (without certificate checks, as Railway's public proxy needs) for anything else.
 */
export function poolConfig(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig & { sslMode: string } {
  const url = new URL(databaseUrl);
  const mode = (url.searchParams.get("sslmode") ?? env.PGSSLMODE ?? "").toLowerCase();
  // pg lets URL ssl params override the `ssl` option, so strip them and decide here.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("ssl");
  const host = url.hostname.toLowerCase();

  let ssl: pg.PoolConfig["ssl"];
  if (mode === "disable" || mode === "allow") ssl = false;
  else if (mode === "verify-ca" || mode === "verify-full") ssl = { rejectUnauthorized: true };
  else if (mode === "require" || mode === "prefer" || mode === "no-verify") ssl = { rejectUnauthorized: false };
  else if (mode) throw new Error(`Unknown sslmode "${mode}" (use disable, require, no-verify or verify-full).`);
  else if (LOCAL_HOSTS.has(host) || !host.includes(".") || host.endsWith(".railway.internal")) ssl = false;
  else ssl = { rejectUnauthorized: false };

  const sslMode = ssl === false ? "off" : ssl.rejectUnauthorized ? "verified" : "on, unverified";
  return { connectionString: url.toString(), ssl, max: 10, sslMode };
}

/** Postgres store, used when DATABASE_URL is set. Call `PostgresStore.connect()` rather than `new`. */
export class PostgresStore implements Store {
  readonly pool: pg.Pool;
  readonly summary: string;
  corpusVersion = 0;

  private constructor(pool: pg.Pool, summary: string) {
    this.pool = pool;
    this.summary = summary;
  }

  static async connect(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<PostgresStore> {
    const { sslMode, ...config } = poolConfig(databaseUrl, env);
    const url = new URL(config.connectionString!);
    const pool = new pg.Pool(config);
    // An idle client erroring (e.g. the server restarting) must not crash the process.
    pool.on("error", (err) => console.error("Postgres pool error:", err.message));
    const store = new PostgresStore(pool, `Postgres at ${url.hostname}:${url.port || 5432}${url.pathname} (SSL ${sslMode})`);
    await store.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
      await db.query(SCHEMA);
    });
    return store;
  }

  private async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows.map(formatDates) as T[];
  }

  private async row<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.rows<T>(sql, params))[0];
  }

  private async changed(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.pool.query(sql, params)).rowCount ?? 0;
  }

  private async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const out = await fn(db);
      await db.query("COMMIT");
      return out;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  // ---- clients ----

  listClients(): Promise<Client[]> {
    return this.rows("SELECT * FROM clients ORDER BY lower(name), id");
  }

  getClient(id: number): Promise<Client | undefined> {
    return this.row("SELECT * FROM clients WHERE id = $1", [id]);
  }

  async createClient(input: ClientInput): Promise<Client> {
    return (await this.row<Client>(
      `INSERT INTO clients (name, aliases, company, service_type, target_audience, tone, formality,
         style_notes, sample_messages, booking_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      clientParams(input),
    ))!;
  }

  updateClient(id: number, input: ClientInput): Promise<Client | undefined> {
    return this.row(
      `UPDATE clients SET name = $1, aliases = $2, company = $3, service_type = $4, target_audience = $5,
         tone = $6, formality = $7, style_notes = $8, sample_messages = $9, booking_link = $10,
         updated_at = now()
       WHERE id = $11 RETURNING *`,
      [...clientParams(input), id],
    );
  }

  async deleteClient(id: number): Promise<boolean> {
    return (await this.changed("DELETE FROM clients WHERE id = $1", [id])) > 0;
  }

  // ---- favorites ----

  listFavorites(clientId: number, limit = 100): Promise<Favorite[]> {
    return this.rows("SELECT * FROM favorites WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [
      clientId,
      limit,
    ]);
  }

  async addFavorite(f: Omit<Favorite, "id" | "created_at">): Promise<Favorite> {
    return (await this.row<Favorite>(
      `INSERT INTO favorites (client_id, strategy, objection_text, response_text, prospect_name, generation_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [f.client_id, f.strategy, f.objection_text, f.response_text, f.prospect_name, f.generation_id],
    ))!;
  }

  async deleteFavorite(id: number): Promise<boolean> {
    return (await this.changed("DELETE FROM favorites WHERE id = $1", [id])) > 0;
  }

  // ---- chat history ----

  async addTurn(t: Omit<Turn, "id" | "created_at">): Promise<Turn> {
    return (await this.row<Turn>(
      `INSERT INTO generations (client_id, objection_text, prospect_name, thread_context, guidance, image, result, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        t.client_id,
        t.objection_text,
        t.prospect_name,
        t.thread_context,
        t.guidance,
        t.image,
        JSON.stringify(t.result),
        JSON.stringify(t.sources),
      ],
    ))!;
  }

  getTurn(id: number): Promise<Turn | undefined> {
    return this.row("SELECT * FROM generations WHERE id = $1", [id]);
  }

  listTurns(clientId: number): Promise<Turn[]> {
    return this.rows("SELECT * FROM generations WHERE client_id = $1 ORDER BY created_at, id", [clientId]);
  }

  deleteTurn(id: number): Promise<Turn | undefined> {
    return this.row("DELETE FROM generations WHERE id = $1 RETURNING *", [id]);
  }

  listConversations(): Promise<Conversation[]> {
    return this.rows(
      `SELECT c.id AS client_id, c.name, c.company, COUNT(g.id)::int AS turns, MAX(g.created_at) AS last_at
       FROM clients c LEFT JOIN generations g ON g.client_id = c.id
       GROUP BY c.id
       ORDER BY last_at DESC NULLS LAST, lower(c.name)`,
    );
  }

  // ---- corpus ----

  listDocuments(): Promise<CorpusDocument[]> {
    return this.rows(
      `SELECT d.id, d.title, d.filename, d.source, d.pinned, d.created_at,
              COUNT(c.id)::int AS chunk_count,
              COALESCE(SUM(LENGTH(c.text) - LENGTH(REPLACE(c.text, ' ', '')) + 1), 0)::int AS word_count
       FROM corpus_documents d LEFT JOIN corpus_chunks c ON c.document_id = d.id
       GROUP BY d.id ORDER BY d.pinned DESC, lower(d.title), d.id`,
    );
  }

  async upsertDocument(doc: ParsedDocument, opts: UpsertOptions): Promise<boolean> {
    const hash = documentHash(doc);
    const existing = await this.row<{ id: number; content_hash: string; pinned: boolean }>(
      "SELECT id, content_hash, pinned FROM corpus_documents WHERE filename = $1",
      [opts.filename],
    );
    if (existing && existing.content_hash === hash && existing.pinned === opts.pinned) return false;

    const headings: string[] = [];
    const texts: string[] = [];
    for (const section of doc.sections) {
      // Pinned docs are sent whole, so keep each section intact.
      for (const piece of opts.pinned ? [section.text] : chunkText(section.text)) {
        headings.push(section.heading);
        texts.push(piece);
      }
    }
    await this.transaction(async (db) => {
      if (existing) await db.query("DELETE FROM corpus_documents WHERE id = $1", [existing.id]);
      const { rows } = await db.query(
        "INSERT INTO corpus_documents (title, filename, source, pinned, content_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [doc.title, opts.filename, opts.source, opts.pinned, hash],
      );
      await db.query(
        `INSERT INTO corpus_chunks (document_id, heading, text, position)
         SELECT $1, h, t, n - 1 FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS u(h, t, n)`,
        [rows[0].id, headings, texts],
      );
    });
    this.corpusVersion++;
    return true;
  }

  async deleteDocument(id: number): Promise<boolean> {
    const ok = (await this.changed("DELETE FROM corpus_documents WHERE id = $1 AND source = 'upload'", [id])) > 0;
    if (ok) this.corpusVersion++;
    return ok;
  }

  async pruneRepoDocuments(keepFilenames: string[]): Promise<void> {
    const n = await this.changed("DELETE FROM corpus_documents WHERE source = 'repo' AND NOT (filename = ANY($1::text[]))", [
      keepFilenames,
    ]);
    if (n) this.corpusVersion++;
  }

  chunks(pinned: boolean): Promise<CorpusChunk[]> {
    return this.rows(
      `SELECT c.id, c.document_id, d.title AS document_title, c.heading, c.text
       FROM corpus_chunks c JOIN corpus_documents d ON d.id = c.document_id
       WHERE d.pinned = $1 ORDER BY d.id, c.position`,
      [pinned],
    );
  }

  // ---- users & auth tokens ----

  async listUsers(): Promise<User[]> {
    const rows = await this.rows<Record<string, unknown>>("SELECT * FROM users ORDER BY created_at, id");
    return rows.map((r) => publicUser(rowToUserRecord(r)));
  }

  async getUserRecord(id: number): Promise<UserRecord | undefined> {
    const r = await this.row<Record<string, unknown>>("SELECT * FROM users WHERE id = $1", [id]);
    return r ? rowToUserRecord(r) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const r = await this.row<Record<string, unknown>>("SELECT * FROM users WHERE email = $1", [email]);
    return r ? rowToUserRecord(r) : undefined;
  }

  async createUser(u: { email: string; name: string }): Promise<User> {
    const r = await this.row<Record<string, unknown>>(
      "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *",
      [u.email, u.name],
    );
    return publicUser(rowToUserRecord(r!));
  }

  async updateUser(id: number, patch: UserPatch): Promise<User | undefined> {
    const entries = userPatchEntries(patch);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(", ");
      // last_login_at arrives as a SQLite-style UTC string; tag it so Postgres doesn't read it as local time.
      const values = entries.map(([k, v]) => (k === "last_login_at" ? `${v}Z` : v));
      await this.pool.query(`UPDATE users SET ${sets} WHERE id = $${entries.length + 1}`, [...values, id]);
    }
    const u = await this.getUserRecord(id);
    return u && publicUser(u);
  }

  async deleteUser(id: number): Promise<boolean> {
    return (await this.changed("DELETE FROM users WHERE id = $1", [id])) > 0;
  }

  async addToken(t: { token_hash: string; user_id: number; kind: TokenKind; expires_at: string }): Promise<void> {
    await this.pool.query(
      "INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)",
      [t.token_hash, t.user_id, t.kind, `${t.expires_at}Z`],
    );
  }

  async findToken(token_hash: string, kind: TokenKind): Promise<number | undefined> {
    const r = await this.row<{ user_id: number }>(
      "SELECT user_id FROM auth_tokens WHERE token_hash = $1 AND kind = $2 AND expires_at > now()",
      [token_hash, kind],
    );
    return r?.user_id;
  }

  async deleteToken(token_hash: string): Promise<void> {
    await this.pool.query("DELETE FROM auth_tokens WHERE token_hash = $1", [token_hash]);
  }

  async deleteUserTokens(user_id: number, kinds: TokenKind[]): Promise<void> {
    await this.pool.query("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = ANY($2)", [user_id, kinds]);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

function clientParams(input: ClientInput): unknown[] {
  return [
    input.name,
    JSON.stringify(input.aliases),
    input.company,
    input.service_type,
    input.target_audience,
    input.tone,
    input.formality,
    input.style_notes,
    input.sample_messages,
    input.booking_link,
  ];
}

/** pg returns TIMESTAMPTZ as Date; the API (and frontend) expect SQLite-style UTC strings. */
function formatDates(row: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) if (v instanceof Date) row[k] = sqlTimestamp(v);
  return row;
}
