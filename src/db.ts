import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ParsedDocument } from "./corpus/ingest.ts";

export type Strategy = "intro_call" | "leave_door_open" | "continue_conversation";
export const STRATEGIES: Strategy[] = ["intro_call", "leave_door_open", "continue_conversation"];

export interface Client {
  id: number;
  name: string;
  aliases: string[];
  company: string;
  service_type: string;
  target_audience: string;
  tone: string;
  formality: string;
  style_notes: string;
  sample_messages: string;
  booking_link: string;
  /** Where the client is based; shapes regulations, accounts and lingo in replies. */
  country: string;
  created_at: string;
  updated_at: string;
}

export type ClientInput = Omit<Client, "id" | "created_at" | "updated_at">;

export interface Favorite {
  id: number;
  client_id: number;
  strategy: Strategy;
  objection_text: string;
  response_text: string;
  prospect_name: string;
  generation_id: number | null;
  created_at: string;
}

/** One turn in a client's chat: the objection that came in and the three replies written for it. */
export interface Turn {
  id: number;
  client_id: number | null;
  objection_text: string;
  prospect_name: string;
  thread_context: string;
  guidance: string;
  image: string;
  result: unknown;
  sources: { document: string; section: string }[];
  created_at: string;
}

export interface Conversation {
  client_id: number;
  name: string;
  company: string;
  turns: number;
  last_at: string | null;
}

/** A person who can sign in. `has_password` is false until they accept their invite. */
export interface User {
  id: number;
  email: string;
  name: string;
  active: boolean;
  has_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** Internal only: never send this to the browser. */
export interface UserRecord extends User {
  password_hash: string;
}

export type UserPatch = Partial<{ name: string; active: boolean; password_hash: string; last_login_at: string }>;

/** Sessions keep someone signed in; invite and reset tokens are one-time links. */
export type TokenKind = "session" | "invite" | "reset";

export interface CorpusDocument {
  id: number;
  title: string;
  filename: string;
  source: "repo" | "upload";
  pinned: boolean;
  chunk_count: number;
  word_count: number;
  created_at: string;
}

export interface CorpusChunk {
  id: number;
  document_id: number;
  document_title: string;
  heading: string;
  text: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  company TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  target_audience TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  formality TEXT NOT NULL DEFAULT '',
  style_notes TEXT NOT NULL DEFAULT '',
  sample_messages TEXT NOT NULL DEFAULT '',
  booking_link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  objection_text TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL,
  prospect_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS favorites_client ON favorites(client_id, created_at);
CREATE TABLE IF NOT EXISTS corpus_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS corpus_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES corpus_documents(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id, kind);
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  objection_text TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Columns added after the first release; applied to existing databases on startup. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "generations", column: "prospect_name", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "generations", column: "thread_context", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "generations", column: "guidance", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "generations", column: "image", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "generations", column: "sources", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "favorites", column: "generation_id", ddl: "INTEGER REFERENCES generations(id) ON DELETE SET NULL" },
  { table: "clients", column: "country", ddl: "TEXT NOT NULL DEFAULT ''" },
];

/** Chunk size for retrieval, in words, with overlap so ideas aren't cut in half. */
const CHUNK_WORDS = 280;
const CHUNK_OVERLAP = 40;

export function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= CHUNK_WORDS + CHUNK_OVERLAP) return [words.join(" ")];
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - CHUNK_OVERLAP) {
    chunks.push(words.slice(start, start + CHUNK_WORDS).join(" "));
    if (start + CHUNK_WORDS >= words.length) break;
  }
  return chunks;
}

/** SHA-256 of a parsed document, used to skip re-importing unchanged corpus files. */
export function documentHash(doc: ParsedDocument): string {
  return crypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex");
}

/** SQLite's `datetime('now')` format (UTC, no zone). The frontend parses this shape. */
export function sqlTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export type UpsertOptions = { filename: string; source: "repo" | "upload"; pinned: boolean };

/**
 * Everything the app persists except screenshots. Implemented by SqliteStore
 * (local dev, tests) and PostgresStore (production, when DATABASE_URL is set).
 */
export interface Store {
  /** Human-readable description for the startup log; never includes secrets. */
  readonly summary: string;
  /** Bumped whenever corpus content changes so the retrieval index knows to rebuild. */
  corpusVersion: number;

  listClients(): Promise<Client[]>;
  getClient(id: number): Promise<Client | undefined>;
  createClient(input: ClientInput): Promise<Client>;
  updateClient(id: number, input: ClientInput): Promise<Client | undefined>;
  deleteClient(id: number): Promise<boolean>;

  listFavorites(clientId: number, limit?: number): Promise<Favorite[]>;
  addFavorite(f: Omit<Favorite, "id" | "created_at">): Promise<Favorite>;
  deleteFavorite(id: number): Promise<boolean>;

  addTurn(t: Omit<Turn, "id" | "created_at">): Promise<Turn>;
  getTurn(id: number): Promise<Turn | undefined>;
  listTurns(clientId: number): Promise<Turn[]>;
  deleteTurn(id: number): Promise<Turn | undefined>;
  /** Every client as a sidebar conversation, most recently active first. */
  listConversations(): Promise<Conversation[]>;

  listDocuments(): Promise<CorpusDocument[]>;
  /**
   * Insert or replace a document. Resolves false when the stored copy already
   * has identical content, so repo sync on startup is a no-op most of the time.
   */
  upsertDocument(doc: ParsedDocument, opts: UpsertOptions): Promise<boolean>;
  /** Only uploaded documents can be deleted; built-in ones live in the repo. */
  deleteDocument(id: number): Promise<boolean>;
  /** Remove repo-sourced documents whose file no longer exists in corpus/. */
  pruneRepoDocuments(keepFilenames: string[]): Promise<void>;
  chunks(pinned: boolean): Promise<CorpusChunk[]>;

  // Emails are stored lowercase; callers normalise before calling.
  listUsers(): Promise<User[]>;
  getUserRecord(id: number): Promise<UserRecord | undefined>;
  getUserByEmail(email: string): Promise<UserRecord | undefined>;
  createUser(u: { email: string; name: string }): Promise<User>;
  updateUser(id: number, patch: UserPatch): Promise<User | undefined>;
  deleteUser(id: number): Promise<boolean>;

  /** Tokens are stored as SHA-256 hashes; the raw value only ever lives in the cookie or link. */
  addToken(t: { token_hash: string; user_id: number; kind: TokenKind; expires_at: string }): Promise<void>;
  /** The token's user id, if it exists, matches the kind and hasn't expired. */
  findToken(token_hash: string, kind: TokenKind): Promise<number | undefined>;
  deleteToken(token_hash: string): Promise<void>;
  deleteUserTokens(user_id: number, kinds: TokenKind[]): Promise<void>;

  close(): Promise<void>;
}

const USER_FIELDS: (keyof UserPatch)[] = ["name", "active", "password_hash", "last_login_at"];

/** Shared row mapping: drivers return 0/1 or booleans for `active`. */
export function rowToUserRecord(r: Record<string, unknown>): UserRecord {
  return {
    id: Number(r.id),
    email: String(r.email),
    name: String(r.name ?? ""),
    active: Boolean(r.active),
    has_password: Boolean(r.password_hash),
    password_hash: String(r.password_hash ?? ""),
    created_at: String(r.created_at),
    last_login_at: r.last_login_at == null ? null : String(r.last_login_at),
  };
}

export function publicUser(u: UserRecord): User {
  const { password_hash: _, ...rest } = u;
  return rest;
}

/** The columns and values an UpdateUser patch touches, in a fixed order. */
export function userPatchEntries(patch: UserPatch): [keyof UserPatch, unknown][] {
  return USER_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]);
}

type Row = Record<string, unknown>;

function rowToTurn(r: Row): Turn {
  return {
    ...(r as unknown as Turn),
    result: JSON.parse(String(r.result)),
    sources: JSON.parse(String(r.sources ?? "[]")),
  };
}

function rowToClient(r: Row): Client {
  return { ...(r as unknown as Client), aliases: JSON.parse(String(r.aliases ?? "[]")) };
}

/** SQLite via node:sqlite. The driver is synchronous; methods are async to share the Store interface. */
export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  readonly summary: string;
  corpusVersion = 0;

  constructor(file: string) {
    this.summary = file === ":memory:" ? "SQLite (in memory)" : `SQLite at ${file}`;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    for (const m of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === m.column)) {
        this.db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS generations_client ON generations(client_id, created_at)");
  }

  // ---- clients ----

  async listClients(): Promise<Client[]> {
    return this.db.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all().map(rowToClient);
  }

  async getClient(id: number): Promise<Client | undefined> {
    const r = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    return r ? rowToClient(r) : undefined;
  }

  async createClient(input: ClientInput): Promise<Client> {
    const r = this.db
      .prepare(
        `INSERT INTO clients (name, aliases, company, service_type, target_audience, tone, formality,
           style_notes, sample_messages, booking_link, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
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
        input.country ?? "",
      ) as { id: number };
    return (await this.getClient(r.id))!;
  }

  async updateClient(id: number, input: ClientInput): Promise<Client | undefined> {
    const res = this.db
      .prepare(
        `UPDATE clients SET name = ?, aliases = ?, company = ?, service_type = ?, target_audience = ?,
           tone = ?, formality = ?, style_notes = ?, sample_messages = ?, booking_link = ?, country = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
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
        input.country ?? "",
        id,
      );
    return res.changes ? await this.getClient(id) : undefined;
  }

  async deleteClient(id: number): Promise<boolean> {
    return this.db.prepare("DELETE FROM clients WHERE id = ?").run(id).changes > 0;
  }

  // ---- favorites ----

  async listFavorites(clientId: number, limit = 100): Promise<Favorite[]> {
    return this.db
      .prepare("SELECT * FROM favorites WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(clientId, limit) as unknown as Favorite[];
  }

  async addFavorite(f: Omit<Favorite, "id" | "created_at">): Promise<Favorite> {
    return this.db
      .prepare(
        `INSERT INTO favorites (client_id, strategy, objection_text, response_text, prospect_name, generation_id)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        f.client_id,
        f.strategy,
        f.objection_text,
        f.response_text,
        f.prospect_name,
        f.generation_id,
      ) as unknown as Favorite;
  }

  async deleteFavorite(id: number): Promise<boolean> {
    return this.db.prepare("DELETE FROM favorites WHERE id = ?").run(id).changes > 0;
  }

  // ---- chat history (one turn per objection answered) ----

  async addTurn(t: Omit<Turn, "id" | "created_at">): Promise<Turn> {
    const r = this.db
      .prepare(
        `INSERT INTO generations (client_id, objection_text, prospect_name, thread_context, guidance, image, result, sources)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        t.client_id,
        t.objection_text,
        t.prospect_name,
        t.thread_context,
        t.guidance,
        t.image,
        JSON.stringify(t.result),
        JSON.stringify(t.sources),
      ) as { id: number };
    return (await this.getTurn(r.id))!;
  }

  async getTurn(id: number): Promise<Turn | undefined> {
    const r = this.db.prepare("SELECT * FROM generations WHERE id = ?").get(id);
    return r ? rowToTurn(r) : undefined;
  }

  async listTurns(clientId: number): Promise<Turn[]> {
    return this.db
      .prepare("SELECT * FROM generations WHERE client_id = ? ORDER BY created_at, id")
      .all(clientId)
      .map(rowToTurn);
  }

  async deleteTurn(id: number): Promise<Turn | undefined> {
    const turn = await this.getTurn(id);
    if (turn) this.db.prepare("DELETE FROM generations WHERE id = ?").run(id);
    return turn;
  }

  /** Every client as a sidebar conversation, most recently active first. */
  async listConversations(): Promise<Conversation[]> {
    return this.db
      .prepare(
        `SELECT c.id AS client_id, c.name, c.company, COUNT(g.id) AS turns, MAX(g.created_at) AS last_at
         FROM clients c LEFT JOIN generations g ON g.client_id = c.id
         GROUP BY c.id
         ORDER BY last_at IS NULL, last_at DESC, c.name COLLATE NOCASE`,
      )
      .all() as unknown as Conversation[];
  }

  // ---- corpus ----

  async listDocuments(): Promise<CorpusDocument[]> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.title, d.filename, d.source, d.pinned, d.created_at,
                COUNT(c.id) AS chunk_count, COALESCE(SUM(LENGTH(c.text) - LENGTH(REPLACE(c.text, ' ', '')) + 1), 0) AS word_count
         FROM corpus_documents d LEFT JOIN corpus_chunks c ON c.document_id = d.id
         GROUP BY d.id ORDER BY d.pinned DESC, d.title COLLATE NOCASE`,
      )
      .all();
    return rows.map((r) => ({ ...(r as unknown as CorpusDocument), pinned: Boolean(r.pinned) }));
  }

  /**
   * Insert or replace a document. Returns false when the stored copy already
   * has identical content, so repo sync on startup is a no-op most of the time.
   */
  async upsertDocument(
    doc: ParsedDocument,
    opts: UpsertOptions,
  ): Promise<boolean> {
    const hash = documentHash(doc);
    const existing = this.db
      .prepare("SELECT id, content_hash, pinned FROM corpus_documents WHERE filename = ?")
      .get(opts.filename) as { id: number; content_hash: string; pinned: number } | undefined;
    if (existing && existing.content_hash === hash && Boolean(existing.pinned) === opts.pinned) return false;

    this.db.exec("BEGIN");
    try {
      if (existing) this.db.prepare("DELETE FROM corpus_documents WHERE id = ?").run(existing.id);
      const { id } = this.db
        .prepare(
          "INSERT INTO corpus_documents (title, filename, source, pinned, content_hash) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .get(doc.title, opts.filename, opts.source, opts.pinned ? 1 : 0, hash) as { id: number };
      const insert = this.db.prepare(
        "INSERT INTO corpus_chunks (document_id, heading, text, position) VALUES (?, ?, ?, ?)",
      );
      let position = 0;
      for (const section of doc.sections) {
        // Pinned docs are sent whole, so keep each section intact.
        const pieces = opts.pinned ? [section.text] : chunkText(section.text);
        for (const piece of pieces) insert.run(id, section.heading, piece, position++);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.corpusVersion++;
    return true;
  }

  async deleteDocument(id: number): Promise<boolean> {
    const ok = this.db.prepare("DELETE FROM corpus_documents WHERE id = ? AND source = 'upload'").run(id).changes > 0;
    if (ok) this.corpusVersion++;
    return ok;
  }

  /** Remove repo-sourced documents whose file no longer exists in corpus/. */
  async pruneRepoDocuments(keepFilenames: string[]): Promise<void> {
    const rows = this.db.prepare("SELECT id, filename FROM corpus_documents WHERE source = 'repo'").all() as {
      id: number;
      filename: string;
    }[];
    for (const r of rows) {
      if (!keepFilenames.includes(r.filename)) {
        this.db.prepare("DELETE FROM corpus_documents WHERE id = ?").run(r.id);
        this.corpusVersion++;
      }
    }
  }

  async chunks(pinned: boolean): Promise<CorpusChunk[]> {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, d.title AS document_title, c.heading, c.text
         FROM corpus_chunks c JOIN corpus_documents d ON d.id = c.document_id
         WHERE d.pinned = ? ORDER BY d.id, c.position`,
      )
      .all(pinned ? 1 : 0) as unknown as CorpusChunk[];
  }

  // ---- users & auth tokens ----

  async listUsers(): Promise<User[]> {
    return this.db
      .prepare("SELECT * FROM users ORDER BY created_at, id")
      .all()
      .map((r) => publicUser(rowToUserRecord(r)));
  }

  async getUserRecord(id: number): Promise<UserRecord | undefined> {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return r ? rowToUserRecord(r) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return r ? rowToUserRecord(r) : undefined;
  }

  async createUser(u: { email: string; name: string }): Promise<User> {
    const r = this.db.prepare("INSERT INTO users (email, name) VALUES (?, ?) RETURNING *").get(u.email, u.name)!;
    return publicUser(rowToUserRecord(r));
  }

  async updateUser(id: number, patch: UserPatch): Promise<User | undefined> {
    const entries = userPatchEntries(patch);
    if (entries.length) {
      const sets = entries.map(([k]) => `${k} = ?`).join(", ");
      const values = entries.map(([k, v]) => (k === "active" ? (v ? 1 : 0) : v)) as (string | number)[];
      this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
    }
    const u = await this.getUserRecord(id);
    return u && publicUser(u);
  }

  async deleteUser(id: number): Promise<boolean> {
    return this.db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  async addToken(t: { token_hash: string; user_id: number; kind: TokenKind; expires_at: string }): Promise<void> {
    this.db
      .prepare("INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)")
      .run(t.token_hash, t.user_id, t.kind, t.expires_at);
  }

  async findToken(token_hash: string, kind: TokenKind): Promise<number | undefined> {
    const r = this.db
      .prepare("SELECT user_id FROM auth_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?")
      .get(token_hash, kind, sqlTimestamp(new Date())) as { user_id: number } | undefined;
    return r?.user_id;
  }

  async deleteToken(token_hash: string): Promise<void> {
    this.db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").run(token_hash);
  }

  async deleteUserTokens(user_id: number, kinds: TokenKind[]): Promise<void> {
    const del = this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?");
    for (const k of kinds) del.run(user_id, k);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
