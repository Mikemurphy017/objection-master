import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STRATEGIES, Store, type ClientInput } from "./db.ts";
import { matchClient } from "./match.ts";
import { Bm25Index, retrieveExcerpts } from "./corpus/retrieval.ts";
import { parseFile } from "./corpus/ingest.ts";
import { extractFromScreenshot, isSupportedImage } from "./ai/extract.ts";
import type { GenerateInput, Generation } from "./ai/generate.ts";
import { GenerationError } from "./ai/errors.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

/** Pluggable model calls so tests can run without the Anthropic API. */
export interface AiBackend {
  extract: typeof extractFromScreenshot;
  generate: (input: GenerateInput) => Promise<Generation>;
}

const ClientBody = z.object({
  name: z.string().trim().min(1, "Name is required"),
  aliases: z
    .union([z.array(z.string()), z.string()])
    .default([])
    .transform((v) =>
      (Array.isArray(v) ? v : v.split(/[,\n]/)).map((s) => s.trim()).filter(Boolean),
    ),
  company: z.string().trim().default(""),
  service_type: z.string().trim().default(""),
  target_audience: z.string().trim().default(""),
  tone: z.string().trim().default(""),
  formality: z.string().trim().default(""),
  style_notes: z.string().trim().default(""),
  sample_messages: z.string().trim().default(""),
  booking_link: z.string().trim().default(""),
});

const GenerateBody = z.object({
  clientId: z.coerce.number().int().positive(),
  objection: z.string().trim().min(1, "Objection text is required"),
  threadContext: z.string().default(""),
  prospectName: z.string().nullable().optional(),
  prospectHeadline: z.string().nullable().optional(),
  channel: z.string().optional(),
  guidance: z.string().optional(),
});

const FavoriteBody = z.object({
  clientId: z.coerce.number().int().positive(),
  strategy: z.enum(STRATEGIES as [string, ...string[]]),
  objection: z.string().default(""),
  response: z.string().trim().min(1),
  prospectName: z.string().nullable().optional(),
});

/** Sync every markdown file in corpus/ into the store. Files named core-* are always-included. */
export async function syncRepoCorpus(store: Store, dir = path.join(ROOT, "corpus")): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f));
  for (const file of files) {
    const doc = await parseFile(file, fs.readFileSync(path.join(dir, file)));
    store.upsertDocument(doc, { filename: file, source: "repo", pinned: file.startsWith("core-") });
  }
  store.pruneRepoDocuments(files);
}

function basicAuth(password: string) {
  const expected = Buffer.from(password);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const supplied = Buffer.from(Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":"));
      if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Objection Master Pro"').status(401).send("Authentication required");
  };
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export function createApp(store: Store, ai: AiBackend, opts: { password?: string } = {}) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

  let index: Bm25Index | null = null;
  let indexVersion = -1;
  const corpusIndex = () => {
    if (!index || indexVersion !== store.corpusVersion) {
      index = new Bm25Index(store.chunks(false));
      indexVersion = store.corpusVersion;
    }
    return index;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  if (opts.password) app.use(basicAuth(opts.password));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(ROOT, "public")));

  // ---- clients ----

  app.get("/api/clients", (_req, res) => {
    res.json(store.listClients());
  });

  app.post(
    "/api/clients",
    route((req, res) => {
      const body = ClientBody.parse(req.body) as ClientInput;
      res.status(201).json(store.createClient(body));
    }),
  );

  app.put(
    "/api/clients/:id",
    route((req, res) => {
      const body = ClientBody.parse(req.body) as ClientInput;
      const updated = store.updateClient(Number(req.params.id), body);
      if (!updated) return res.status(404).json({ error: "Client not found" });
      res.json(updated);
    }),
  );

  app.delete("/api/clients/:id", (req, res) => {
    if (!store.deleteClient(Number(req.params.id))) return res.status(404).json({ error: "Client not found" });
    res.status(204).end();
  });

  // ---- favorites ----

  app.get("/api/clients/:id/favorites", (req, res) => {
    res.json(store.listFavorites(Number(req.params.id)));
  });

  app.post(
    "/api/favorites",
    route((req, res) => {
      const body = FavoriteBody.parse(req.body);
      if (!store.getClient(body.clientId)) return res.status(404).json({ error: "Client not found" });
      const fav = store.addFavorite({
        client_id: body.clientId,
        strategy: body.strategy as (typeof STRATEGIES)[number],
        objection_text: body.objection,
        response_text: body.response,
        prospect_name: body.prospectName ?? "",
      });
      res.status(201).json(fav);
    }),
  );

  app.delete("/api/favorites/:id", (req, res) => {
    if (!store.deleteFavorite(Number(req.params.id))) return res.status(404).json({ error: "Favorite not found" });
    res.status(204).end();
  });

  // ---- pipeline: screenshot -> extraction + client match ----

  app.post(
    "/api/analyze",
    upload.single("screenshot"),
    route(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Upload a screenshot image." });
      if (!isSupportedImage(req.file.mimetype)) {
        return res.status(400).json({ error: "Screenshot must be a PNG, JPEG, GIF or WebP image." });
      }
      const clients = store.listClients();
      const extraction = await ai.extract({ data: req.file.buffer, mimeType: req.file.mimetype }, clients.map((c) => c.name));
      const match = matchClient([extraction.client_match, extraction.client_name], clients);
      res.json({
        extraction,
        match: { clientId: match.client?.id ?? null, score: match.score, candidates: match.candidates },
        favorites: match.client ? store.listFavorites(match.client.id, 20) : [],
      });
    }),
  );

  // ---- pipeline: objection + client -> three options ----

  app.post(
    "/api/generate",
    route(async (req, res) => {
      const body = GenerateBody.parse(req.body);
      const client = store.getClient(body.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const excerpts = retrieveExcerpts(corpusIndex(), body.objection, body.threadContext, client.service_type);
      const favorites = store.listFavorites(client.id, 8);

      const result = await ai.generate({
        client,
        objection: body.objection,
        threadContext: body.threadContext,
        prospectName: body.prospectName,
        prospectHeadline: body.prospectHeadline,
        channel: body.channel,
        guidance: body.guidance,
        favorites,
        coreStyle: store.chunks(true),
        excerpts,
      });
      const generationId = store.logGeneration(client.id, body.objection, result);
      res.json({
        generationId,
        result,
        sources: excerpts.map((c) => ({ document: c.document_title, section: c.heading })),
      });
    }),
  );

  // ---- Klaff corpus ----

  app.get("/api/corpus", (_req, res) => {
    res.json(store.listDocuments());
  });

  app.post(
    "/api/corpus",
    upload.single("file"),
    route(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Upload a .docx, .md or .txt file." });
      let doc;
      try {
        doc = await parseFile(req.file.originalname, req.file.buffer);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      if (!doc.sections.length) return res.status(400).json({ error: "No text found in that file." });
      if (typeof req.body.title === "string" && req.body.title.trim()) doc.title = req.body.title.trim();
      store.upsertDocument(doc, { filename: `upload:${req.file.originalname}`, source: "upload", pinned: false });
      res.status(201).json(store.listDocuments());
    }),
  );

  app.delete("/api/corpus/:id", (req, res) => {
    if (!store.deleteDocument(Number(req.params.id))) {
      return res.status(404).json({ error: "Not found (built-in documents can only be changed in the repo)." });
    }
    res.status(204).end();
  });

  // ---- errors ----

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues.map((i) => i.message).join("; ") });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is too large (15 MB max)." : err.message });
    }
    if (err instanceof GenerationError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}
