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
import { Bm25Index, retrieveExcerpts } from "./corpus/retrieval.ts";
import { parseFile } from "./corpus/ingest.ts";
import { extractFromScreenshot, isSupportedImage } from "./ai/extract.ts";
import type { GenerateInput, Generation } from "./ai/generate.ts";
import { GenerationError } from "./ai/errors.ts";
import { DEFAULT_OWNER_EMAIL, setupAuth, type AuthOptions } from "./auth.ts";
import { TEMPLATE_CSV, fillBlanks, planImport } from "./clients-csv.ts";

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

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export function createApp(
  store: Store,
  ai: AiBackend,
  /** `auth: false` is for tests only; production always runs with accounts. */
  opts: { auth?: AuthOptions | false; images?: ImageStore } = {},
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

  // Railway terminates TLS at its proxy; trust it so secure cookies and req.ip work.
  app.set("trust proxy", 1);
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.json({ limit: "2mb" }));

  // Sign-in pages and what they need load without a session.
  const publicDir = path.join(ROOT, "public");
  app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));
  app.get("/invite", (_req, res) => res.sendFile(path.join(publicDir, "invite.html")));
  app.get(["/styles.css", "/auth.js"], express.static(publicDir));

  if (opts.auth !== false) {
    const { requireUser, requireOwner } = setupAuth(app, store, opts.auth ?? { ownerEmail: DEFAULT_OWNER_EMAIL });
    // The admin page lives outside public/ so only the owner can even load it.
    app.use("/admin", requireUser, requireOwner, express.static(path.join(ROOT, "admin")));
    app.use(requireUser);
  }
  app.use(express.static(publicDir));

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

  // ---- bulk import from CSV ----

  app.get("/api/clients/import-template.csv", (_req, res) => {
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="clients-template.csv"' });
    res.send(TEMPLATE_CSV);
  });

  /**
   * Upload a CSV of clients. Without `commit` it only previews what would happen.
   * With `commit=true` it creates the new clients; with `fillBlanks=true` it also
   * fills empty fields on clients already on file (never overwriting anything).
   */
  app.post(
    "/api/clients/import",
    upload.single("file"),
    route(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "Choose a CSV file to import." });
      // Excel sometimes saves CSVs as Windows-1252 rather than UTF-8.
      let text = req.file.buffer.toString("utf8");
      if (text.includes("\uFFFD")) text = req.file.buffer.toString("latin1");
      let plan;
      try {
        plan = planImport(text, await store.listClients());
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      if (req.body.commit !== "true") return res.json({ ...plan, committed: false });

      let created = 0;
      let updated = 0;
      for (const row of plan.rows) {
        if (row.status === "new") {
          await store.createClient(row.client);
          created++;
        } else if (row.status === "existing" && req.body.fillBlanks === "true" && row.fillable?.length) {
          const stored = await store.getClient(row.existingId!);
          if (!stored) continue;
          await store.updateClient(stored.id, fillBlanks(stored, row.client, row.fillable));
          updated++;
        }
      }
      res.json({ ...plan, committed: true, created, updated });
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
      // Screenshots are always answered for the client whose chat they were dropped into.
      const client = await store.getClient(Number(req.body?.clientId));
      if (!client) return res.status(400).json({ error: "Open a client's chat (or pick a client) before adding a screenshot." });
      const extraction = await ai.extract({ data: req.file.buffer, mimeType: req.file.mimetype }, client.name);
      // Keep the screenshot so the chat history can show it next to the replies.
      const imageId = `${crypto.randomBytes(16).toString("hex")}.${IMAGE_EXT[req.file.mimetype]}`;
      await images.save(imageId, req.file.buffer, req.file.mimetype);
      res.json({ imageId, extraction, clientId: client.id });
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
      // Logged so failures (bad keys, no credit, outages) show up in the Railway logs.
      console.warn(`[ai] ${err.status}: ${err.message}`);
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}
