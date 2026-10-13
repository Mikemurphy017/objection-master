import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STRATEGIES, type ClientInput, type Store } from "./db.ts";
import { FsImageStore, type ImageStore } from "./images.ts";
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

/** Stored screenshot filenames: a random id plus extension, nothing user-controlled. */
const IMAGE_ID = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

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
  /** Screenshot saved by /api/analyze, shown with this turn in the chat history. */
  imageId: z.string().regex(IMAGE_ID).optional().nullable(),
});

const FavoriteBody = z.object({
  clientId: z.coerce.number().int().positive(),
  strategy: z.enum(STRATEGIES as [string, ...string[]]),
  objection: z.string().default(""),
  response: z.string().trim().min(1),
  prospectName: z.string().nullable().optional(),
  turnId: z.coerce.number().int().positive().optional().nullable(),
});

/** Sync every markdown file in corpus/ into the store. Files named core-* are always-included. */
export async function syncRepoCorpus(store: Store, dir = path.join(ROOT, "corpus")): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f));
  for (const file of files) {
    const doc = await parseFile(file, fs.readFileSync(path.join(dir, file)));
    await store.upsertDocument(doc, { filename: file, source: "repo", pinned: file.startsWith("core-") });
  }
  await store.pruneRepoDocuments(files);
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

export function createApp(
  store: Store,
  ai: AiBackend,
  opts: { password?: string; images?: ImageStore } = {},
) {
  const app = express();
  const images = opts.images ?? new FsImageStore(path.join(ROOT, "data", "uploads"));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

  let index: Bm25Index | null = null;
  let indexVersion = -1;
  const corpusIndex = async () => {
    if (!index || indexVersion !== store.corpusVersion) {
      const version = store.corpusVersion;
      index = new Bm25Index(await store.chunks(false));
      indexVersion = version;
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

  app.get(
    "/api/clients",
    route(async (_req, res) => {
      res.json(await store.listClients());
    }),
  );

  app.post(
    "/api/clients",
    route(async (req, res) => {
      const body = ClientBody.parse(req.body) as ClientInput;
      res.status(201).json(await store.createClient(body));
    }),
  );

  app.put(
    "/api/clients/:id",
    route(async (req, res) => {
      const body = ClientBody.parse(req.body) as ClientInput;
      const updated = await store.updateClient(Number(req.params.id), body);
      if (!updated) return res.status(404).json({ error: "Client not found" });
      res.json(updated);
    }),
  );

  app.delete(
    "/api/clients/:id",
    route(async (req, res) => {
      if (!(await store.deleteClient(Number(req.params.id)))) return res.status(404).json({ error: "Client not found" });
      res.status(204).end();
    }),
  );

  // ---- favorites ----

  app.get(
    "/api/clients/:id/favorites",
    route(async (req, res) => {
      res.json(await store.listFavorites(Number(req.params.id)));
    }),
  );

  app.post(
    "/api/favorites",
    route(async (req, res) => {
      const body = FavoriteBody.parse(req.body);
      if (!(await store.getClient(body.clientId))) return res.status(404).json({ error: "Client not found" });
      const fav = await store.addFavorite({
        client_id: body.clientId,
        strategy: body.strategy as (typeof STRATEGIES)[number],
        objection_text: body.objection,
        response_text: body.response,
        prospect_name: body.prospectName ?? "",
        generation_id: body.turnId && (await store.getTurn(body.turnId)) ? body.turnId : null,
      });
      res.status(201).json(fav);
    }),
  );

  app.delete(
    "/api/favorites/:id",
    route(async (req, res) => {
      if (!(await store.deleteFavorite(Number(req.params.id)))) return res.status(404).json({ error: "Favorite not found" });
      res.status(204).end();
    }),
  );

  // ---- pipeline: screenshot -> extraction + client match ----

  app.post(
    "/api/analyze",
    upload.single("screenshot"),
    route(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Upload a screenshot image." });
      if (!isSupportedImage(req.file.mimetype)) {
        return res.status(400).json({ error: "Screenshot must be a PNG, JPEG, GIF or WebP image." });
      }
      const clients = await store.listClients();
      const extraction = await ai.extract({ data: req.file.buffer, mimeType: req.file.mimetype }, clients.map((c) => c.name));
      const match = matchClient([extraction.client_match, extraction.client_name], clients);
      // Keep the screenshot so the chat history can show it next to the replies.
      const imageId = `${crypto.randomBytes(16).toString("hex")}.${IMAGE_EXT[req.file.mimetype]}`;
      await images.save(imageId, req.file.buffer, req.file.mimetype);
      res.json({
        imageId,
        extraction,
        match: { clientId: match.client?.id ?? null, score: match.score, candidates: match.candidates },
        favorites: match.client ? await store.listFavorites(match.client.id, 20) : [],
      });
    }),
  );

  // ---- pipeline: objection + client -> three options ----

  app.post(
    "/api/generate",
    route(async (req, res) => {
      const body = GenerateBody.parse(req.body);
      const client = await store.getClient(body.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const excerpts = retrieveExcerpts(await corpusIndex(), body.objection, body.threadContext, client.service_type);
      const favorites = await store.listFavorites(client.id, 8);

      const result = await ai.generate({
        client,
        objection: body.objection,
        threadContext: body.threadContext,
        prospectName: body.prospectName,
        prospectHeadline: body.prospectHeadline,
        channel: body.channel,
        guidance: body.guidance,
        favorites,
        coreStyle: await store.chunks(true),
        excerpts,
      });
      const imageId = body.imageId && (await images.exists(body.imageId)) ? body.imageId : "";
      const turn = await store.addTurn({
        client_id: client.id,
        objection_text: body.objection,
        prospect_name: [body.prospectName, body.prospectHeadline].filter(Boolean).join(" - "),
        thread_context: body.threadContext,
        guidance: body.guidance ?? "",
        image: imageId,
        result,
        sources: excerpts.map((c) => ({ document: c.document_title, section: c.heading })),
      });
      res.json(turn);
    }),
  );

  // ---- chat history ----

  app.get(
    "/api/conversations",
    route(async (_req, res) => {
      res.json(await store.listConversations());
    }),
  );

  app.get(
    "/api/clients/:id/turns",
    route(async (req, res) => {
      const clientId = Number(req.params.id);
      if (!(await store.getClient(clientId))) return res.status(404).json({ error: "Client not found" });
      res.json({ turns: await store.listTurns(clientId), favorites: await store.listFavorites(clientId) });
    }),
  );

  app.delete(
    "/api/turns/:id",
    route(async (req, res) => {
      const turn = await store.deleteTurn(Number(req.params.id));
      if (!turn) return res.status(404).json({ error: "Not found" });
      if (turn.image && IMAGE_ID.test(turn.image)) await images.remove(turn.image);
      res.status(204).end();
    }),
  );

  // Screenshots are streamed through the app (behind the password) because the bucket is private.
  app.get(
    "/api/images/:id",
    route(async (req, res) => {
      if (!IMAGE_ID.test(String(req.params.id))) return res.status(404).end();
      const image = await images.get(String(req.params.id));
      if (!image) return res.status(404).end();
      res.set({
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      if (image.length !== undefined) res.set("Content-Length", String(image.length));
      await pipeline(image.body, res);
    }),
  );

  // ---- Klaff corpus ----

  app.get(
    "/api/corpus",
    route(async (_req, res) => {
      res.json(await store.listDocuments());
    }),
  );

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
      await store.upsertDocument(doc, { filename: `upload:${req.file.originalname}`, source: "upload", pinned: false });
      res.status(201).json(await store.listDocuments());
    }),
  );

  app.delete(
    "/api/corpus/:id",
    route(async (req, res) => {
      if (!(await store.deleteDocument(Number(req.params.id)))) {
        return res.status(404).json({ error: "Not found (built-in documents can only be changed in the repo)." });
      }
      res.status(204).end();
    }),
  );

  // ---- errors ----

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.destroy();
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
