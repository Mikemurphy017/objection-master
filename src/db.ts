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
  created_at: string;
}

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
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  objection_text TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

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

type Row = Record<string, unknown>;

function rowToClient(r: Row): Client {
  return { ...(r as unknown as Client), aliases: JSON.parse(String(r.aliases ?? "[]")) };
}

export class Store {
  readonly db: DatabaseSync;
  /** Bumped whenever corpus content changes so the retrieval index knows to rebuild. */
  corpusVersion = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  // ---- clients ----

  listClients(): Client[] {
    return this.db.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all().map(rowToClient);
  }

  getClient(id: number): Client | undefined {
    const r = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    return r ? rowToClient(r) : undefined;
  }

  createClient(input: ClientInput): Client {
    const r = this.db
      .prepare(
        `INSERT INTO clients (name, aliases, company, service_type, target_audience, tone, formality,
           style_notes, sample_messages, booking_link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
      ) as { id: number };
    return this.getClient(r.id)!;
  }

  updateClient(id: number, input: ClientInput): Client | undefined {
    const res = this.db
      .prepare(
        `UPDATE clients SET name = ?, aliases = ?, company = ?, service_type = ?, target_audience = ?,
           tone = ?, formality = ?, style_notes = ?, sample_messages = ?, booking_link = ?,
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
        id,
      );
    return res.changes ? this.getClient(id) : undefined;
  }

  deleteClient(id: number): boolean {
    return this.db.prepare("DELETE FROM clients WHERE id = ?").run(id).changes > 0;
  }

  // ---- favorites ----

  listFavorites(clientId: number, limit = 100): Favorite[] {
    return this.db
      .prepare("SELECT * FROM favorites WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(clientId, limit) as unknown as Favorite[];
  }

  addFavorite(f: Omit<Favorite, "id" | "created_at">): Favorite {
    return this.db
      .prepare(
        `INSERT INTO favorites (client_id, strategy, objection_text, response_text, prospect_name)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(f.client_id, f.strategy, f.objection_text, f.response_text, f.prospect_name) as unknown as Favorite;
  }

  deleteFavorite(id: number): boolean {
    return this.db.prepare("DELETE FROM favorites WHERE id = ?").run(id).changes > 0;
  }

  // ---- generations log ----

  logGeneration(clientId: number | null, objection: string, result: unknown): number {
    const r = this.db
      .prepare("INSERT INTO generations (client_id, objection_text, result) VALUES (?, ?, ?) RETURNING id")
      .get(clientId, objection, JSON.stringify(result)) as { id: number };
    return r.id;
  }

  // ---- corpus ----

  listDocuments(): CorpusDocument[] {
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
  upsertDocument(
    doc: ParsedDocument,
    opts: { filename: string; source: "repo" | "upload"; pinned: boolean },
  ): boolean {
    const hash = crypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex");
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

  deleteDocument(id: number): boolean {
    const ok = this.db.prepare("DELETE FROM corpus_documents WHERE id = ? AND source = 'upload'").run(id).changes > 0;
    if (ok) this.corpusVersion++;
    return ok;
  }

  /** Remove repo-sourced documents whose file no longer exists in corpus/. */
  pruneRepoDocuments(keepFilenames: string[]): void {
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

  chunks(pinned: boolean): CorpusChunk[] {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, d.title AS document_title, c.heading, c.text
         FROM corpus_chunks c JOIN corpus_documents d ON d.id = c.document_id
         WHERE d.pinned = ? ORDER BY d.id, c.position`,
      )
      .all(pinned ? 1 : 0) as unknown as CorpusChunk[];
  }
}
