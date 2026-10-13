import type { Client, ClientInput } from "./db.ts";
import { MATCH_THRESHOLD, nameSimilarity, normalizeName } from "./match.ts";

/** Client fields a CSV can fill. Everything else is left blank for account managers. */
export const IMPORT_FIELDS = [
  "name",
  "aliases",
  "company",
  "service_type",
  "target_audience",
  "tone",
  "formality",
  "style_notes",
  "sample_messages",
  "booking_link",
] as const;
type Field = (typeof IMPORT_FIELDS)[number];

/** Header spellings we recognise (compared lowercase with punctuation removed). */
const HEADER_ALIASES: Record<Field, string[]> = {
  name: ["name", "client", "client name", "full name", "contact", "contact name", "advisor", "advisor name", "linkedin name", "account name"],
  aliases: ["aliases", "alias", "other names", "aka", "nicknames", "nickname", "preferred name", "alternate names", "spellings"],
  company: ["company", "company name", "firm", "firm name", "organization", "organisation", "business", "business name", "practice", "employer"],
  service_type: ["service type", "service", "services", "service offered", "offering", "industry", "vertical", "business type", "what they do"],
  target_audience: ["target audience", "audience", "target", "target market", "icp", "ideal client", "ideal client profile", "niche", "who they target", "prospects"],
  tone: ["tone", "voice", "tone of voice", "messaging tone", "style"],
  formality: ["formality", "formality level", "register"],
  style_notes: ["style notes", "notes", "messaging notes", "phrasing", "phrasing preferences", "dos and donts", "do and dont", "preferences", "messaging preferences", "messaging style", "guidelines"],
  sample_messages: ["sample messages", "sample message", "examples", "example messages", "sample copy", "messages"],
  booking_link: ["booking link", "booking", "calendly", "calendly link", "calendar link", "scheduling link", "meeting link", "book a call", "booking url", "calendar"],
};

const FORMALITY_VALUES = ["Very casual", "Casual", "Conversational professional", "Formal"];

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  // Excel in some locales exports with semicolons; tab-separated files work too.
  const delimiter = [",", ";", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export interface ImportRow {
  /** 1-based line in the spreadsheet (the header is line 1). */
  line: number;
  status: "new" | "existing" | "duplicate" | "invalid";
  reason?: string;
  client: ClientInput;
  /** For "existing": which blank fields on the stored client this row could fill. */
  existingId?: number;
  fillable?: Field[];
  /** Fields still empty after import, i.e. what account managers need to fill in. */
  missing: Field[];
}

export interface ImportPlan {
  columns: { header: string; field: Field | null }[];
  rows: ImportRow[];
  counts: Record<ImportRow["status"], number>;
}

const emptyClient = (): ClientInput => ({
  name: "",
  aliases: [],
  company: "",
  service_type: "",
  target_audience: "",
  tone: "",
  formality: "",
  style_notes: "",
  sample_messages: "",
  booking_link: "",
});

const isBlank = (c: ClientInput | Client, f: Field) => (f === "aliases" ? c.aliases.length === 0 : !String(c[f]).trim());

/** Work out what an import would do, without changing anything. */
export function planImport(text: string, existing: Client[]): ImportPlan {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error("The file needs a header row and at least one client.");
  const [header, ...body] = table;

  const used = new Set<Field>();
  const columns = header.map((h) => {
    const key = headerKey(h);
    const field = (IMPORT_FIELDS.find((f) => !used.has(f) && HEADER_ALIASES[f].includes(key)) ?? null) as Field | null;
    if (field) used.add(field);
    return { header: h.trim(), field };
  });
  const firstCol = header.findIndex((h) => ["first name", "firstname", "first"].includes(headerKey(h)));
  const lastCol = header.findIndex((h) => ["last name", "lastname", "last", "surname"].includes(headerKey(h)));
  if (!used.has("name") && firstCol < 0) {
    throw new Error('No name column found. Add a column called "Name" (or "First Name" and "Last Name").');
  }

  // Same fuzzy rules as screenshot matching: nicknames, middle initials, stored aliases.
  const keys = existing.map((c) => ({ client: c, names: [c.name, ...c.aliases].map(normalizeName) }));
  const findExisting = (name: string) => {
    let best: { client: Client; score: number } | undefined;
    for (const k of keys) {
      const score = Math.max(...k.names.map((n) => nameSimilarity(name, n)));
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { client: k.client, score };
    }
    return best?.client;
  };
  const seenInFile = new Set<string>();
  const rows: ImportRow[] = body.map((cells, i) => {
    const client = emptyClient();
    columns.forEach((col, j) => {
      const value = (cells[j] ?? "").trim();
      if (!col.field || !value) return;
      if (col.field === "aliases") client.aliases = value.split(/[;|\n]/).map((s) => s.trim()).filter(Boolean);
      else if (col.field === "formality") {
        client.formality = FORMALITY_VALUES.find((v) => v.toLowerCase() === value.toLowerCase()) ?? value;
      } else client[col.field] = value;
    });
    if (!client.name && firstCol >= 0) {
      client.name = [cells[firstCol], lastCol >= 0 ? cells[lastCol] : ""].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
    }
    const missing = IMPORT_FIELDS.filter((f) => f !== "name" && isBlank(client, f));
    const line = i + 2;

    if (!client.name) return { line, status: "invalid", reason: "No name", client, missing };
    if (client.booking_link && !/^https?:\/\//i.test(client.booking_link) && /^[\w.-]+\.\w{2,}(\/|$)/.test(client.booking_link)) {
      client.booking_link = `https://${client.booking_link}`;
    }
    const key = normalizeName(client.name);
    if (seenInFile.has(key)) return { line, status: "duplicate", reason: "Listed twice in this file", client, missing };
    seenInFile.add(key);

    const match = findExisting(key);
    if (match) {
      const fillable = IMPORT_FIELDS.filter((f) => f !== "name" && isBlank(match, f) && !isBlank(client, f));
      return { line, status: "existing", reason: `Already on file as ${match.name}`, client, existingId: match.id, fillable, missing };
    }
    return { line, status: "new", client, missing };
  });

  const counts = { new: 0, existing: 0, duplicate: 0, invalid: 0 };
  for (const r of rows) counts[r.status]++;
  return { columns, rows, counts };
}

/** Merge only into fields that are blank on the stored client; never overwrite what a person entered. */
export function fillBlanks(stored: Client, incoming: ClientInput, fields: Field[]): ClientInput {
  const { id: _id, created_at: _c, updated_at: _u, ...current } = stored;
  const merged: ClientInput = { ...current };
  for (const f of fields) {
    if (!isBlank(stored, f)) continue;
    if (f === "aliases") merged.aliases = incoming.aliases;
    else merged[f] = incoming[f];
  }
  return merged;
}

/** Header row for the downloadable template. */
export const TEMPLATE_CSV =
  "Name,Other names,Company,Service type,Target audience,Tone,Formality,Style notes,Sample messages,Booking link\n" +
  'Jane Doe,"Jane A. Doe; Janie Doe",Doe Wealth Partners,Wealth management for business owners,Owners 2-3 years from a sale,"Dry, confident",Conversational professional,"Short sentences. No exclamation points.",,https://calendly.com/janedoe/intro\n';
