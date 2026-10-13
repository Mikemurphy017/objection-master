import crypto from "node:crypto";
import { promisify } from "node:util";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { sqlTimestamp, type Store, type TokenKind, type User } from "./db.ts";

/** The one account that can open /admin. Override with ADMIN_EMAIL. */
export const DEFAULT_OWNER_EMAIL = "mike@bluestonepartnersllc.com";

const SESSION_COOKIE = "om_session";
const DAY = 24 * 60 * 60 * 1000;
const LIFETIME: Record<TokenKind, number> = { session: 30 * DAY, invite: 7 * DAY, reset: 2 * DAY };
const MIN_PASSWORD = 10;

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

// ---------------------------------------------------------------- passwords & tokens

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

const hashToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

/** Create a token of the given kind; the raw value is returned once and only its hash is stored. */
export async function issueToken(store: Store, userId: number, kind: TokenKind): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  await store.addToken({
    token_hash: hashToken(raw),
    user_id: userId,
    kind,
    expires_at: sqlTimestamp(new Date(Date.now() + LIFETIME[kind])),
  });
  return raw;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ---------------------------------------------------------------- owner bootstrap

/**
 * Make sure the owner account exists. If it has no password yet: use ADMIN_PASSWORD
 * when set, otherwise return a one-time setup link path to print in the server log.
 */
export async function ensureOwner(store: Store, ownerEmail: string, adminPassword?: string): Promise<string | null> {
  const email = normalizeEmail(ownerEmail);
  let owner = await store.getUserByEmail(email);
  if (!owner) {
    await store.createUser({ email, name: "" });
    owner = (await store.getUserByEmail(email))!;
  }
  if (!owner.active) await store.updateUser(owner.id, { active: true });
  if (owner.has_password) return null;
  if (adminPassword) {
    await store.updateUser(owner.id, { password_hash: await hashPassword(adminPassword) });
    return null;
  }
  await store.deleteUserTokens(owner.id, ["invite"]);
  return `/invite#${await issueToken(store, owner.id, "invite")}`;
}

// ---------------------------------------------------------------- login throttling

/** At most 10 failed sign-ins per email+IP per 15 minutes. In memory, which is fine for one instance. */
const failures = new Map<string, { count: number; until: number }>();
function throttled(key: string): boolean {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() > f.until) {
    failures.delete(key);
    return false;
  }
  return f.count >= 10;
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (f && Date.now() <= f.until) f.count++;
  else failures.set(key, { count: 1, until: Date.now() + 15 * 60 * 1000 });
}

// ---------------------------------------------------------------- cookies

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function setSessionCookie(req: Request, res: Response, raw: string) {
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: LIFETIME.session,
  });
}

// ---------------------------------------------------------------- middleware & routes

const Credentials = z.object({ email: z.string().trim().min(1), password: z.string().min(1) });
const NewPassword = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(200);
const AcceptBody = z.object({ token: z.string().min(20), password: NewPassword, name: z.string().trim().max(100).optional() });
const InviteBody = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  name: z.string().trim().max(100).default(""),
});
const UpdateBody = z.object({ active: z.boolean().optional(), name: z.string().trim().max(100).optional() });
const ChangePassword = z.object({ current: z.string().min(1), password: NewPassword });

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export interface AuthOptions {
  ownerEmail: string;
}

/**
 * Accounts and sessions. Registers the public auth endpoints and returns
 * `requireUser` (everything else) and `requireOwner` (the admin area).
 */
export function setupAuth(app: express.Express, store: Store, opts: AuthOptions) {
  const ownerEmail = normalizeEmail(opts.ownerEmail);
  const isOwner = (u?: User) => !!u && u.email === ownerEmail;

  async function currentUser(req: Request): Promise<User | undefined> {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) return undefined;
    const userId = await store.findToken(hashToken(raw), "session");
    if (!userId) return undefined;
    const u = await store.getUserRecord(userId);
    if (!u || !u.active) return undefined;
    const { password_hash: _, ...user } = u;
    return user;
  }

  /** Page loads get redirected to the sign-in page; API calls and assets get a plain 401/403. */
  const wantsHtml = (req: Request) =>
    req.method === "GET" && !req.originalUrl.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html");

  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    currentUser(req).then((user) => {
      if (user) {
        req.user = user;
        return next();
      }
      if (wantsHtml(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.status(401).json({ error: "Please sign in." });
    }, next);
  };

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (isOwner(req.user)) return next();
    if (wantsHtml(req)) return res.redirect("/");
    res.status(403).json({ error: "Only the account owner can do that." });
  };

  async function startSession(req: Request, res: Response, userId: number) {
    setSessionCookie(req, res, await issueToken(store, userId, "session"));
    await store.updateUser(userId, { last_login_at: sqlTimestamp(new Date()) });
  }

  // ---- public ----

  app.post(
    "/api/auth/login",
    route(async (req, res) => {
      const { email, password } = Credentials.parse(req.body);
      const key = `${normalizeEmail(email)}|${req.ip}`;
      if (throttled(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
      const user = await store.getUserByEmail(normalizeEmail(email));
      const ok = !!user && user.active && user.has_password && (await verifyPassword(password, user.password_hash));
      if (!ok) {
        recordFailure(key);
        return res.status(401).json({ error: "That email and password don't match an active account." });
      }
      failures.delete(key);
      await startSession(req, res, user.id);
      res.json({ ok: true });
    }),
  );

  /** Who an invite or reset link is for, so the page can greet them. */
  app.get(
    "/api/auth/link/:token",
    route(async (req, res) => {
      const hash = hashToken(String(req.params.token));
      const userId = (await store.findToken(hash, "invite")) ?? (await store.findToken(hash, "reset"));
      const user = userId ? await store.getUserRecord(userId) : undefined;
      if (!user || !user.active) return res.status(404).json({ error: "This link has expired or was already used. Ask Mike for a new one." });
      res.json({ email: user.email, name: user.name, firstTime: !user.has_password });
    }),
  );

  /** Accept an invite or reset link: set the password and sign in. */
  app.post(
    "/api/auth/accept",
    route(async (req, res) => {
      const body = AcceptBody.parse(req.body);
      const hash = hashToken(body.token);
      const userId = (await store.findToken(hash, "invite")) ?? (await store.findToken(hash, "reset"));
      const user = userId ? await store.getUserRecord(userId) : undefined;
      if (!user || !user.active) return res.status(404).json({ error: "This link has expired or was already used. Ask Mike for a new one." });
      await store.updateUser(user.id, {
        password_hash: await hashPassword(body.password),
        ...(body.name ? { name: body.name } : {}),
      });
      // One-time links, and a new password signs out every other device.
      await store.deleteUserTokens(user.id, ["invite", "reset", "session"]);
      await startSession(req, res, user.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/logout",
    route(async (req, res) => {
      const raw = readCookie(req, SESSION_COOKIE);
      if (raw) await store.deleteToken(hashToken(raw));
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.json({ ok: true });
    }),
  );

  // ---- signed in ----

  app.get("/api/me", requireUser, (req, res) => {
    res.json({ ...req.user, isOwner: isOwner(req.user) });
  });

  app.post(
    "/api/me/password",
    requireUser,
    route(async (req, res) => {
      const body = ChangePassword.parse(req.body);
      const user = (await store.getUserRecord(req.user!.id))!;
      if (!(await verifyPassword(body.current, user.password_hash))) {
        return res.status(400).json({ error: "Your current password isn't right." });
      }
      await store.updateUser(user.id, { password_hash: await hashPassword(body.password) });
      await store.deleteUserTokens(user.id, ["session", "reset"]);
      await startSession(req, res, user.id);
      res.json({ ok: true });
    }),
  );

  // ---- admin (owner only) ----

  const admin = express.Router();
  admin.use(requireUser, requireOwner);
  const linkFor = (req: Request, raw: string) => `${req.protocol}://${req.get("host")}/invite#${raw}`;

  admin.get(
    "/users",
    route(async (_req, res) => {
      const users = await store.listUsers();
      res.json(users.map((u) => ({ ...u, isOwner: u.email === ownerEmail })));
    }),
  );

  admin.post(
    "/users",
    route(async (req, res) => {
      const body = InviteBody.parse(req.body);
      const email = normalizeEmail(body.email);
      if (await store.getUserByEmail(email)) return res.status(409).json({ error: `${email} already has an account.` });
      const user = await store.createUser({ email, name: body.name });
      res.status(201).json({ user, link: linkFor(req, await issueToken(store, user.id, "invite")) });
    }),
  );

  /** A fresh link: an invite if they never set a password, otherwise a password reset. */
  admin.post(
    "/users/:id/link",
    route(async (req, res) => {
      const user = await store.getUserRecord(Number(req.params.id));
      if (!user) return res.status(404).json({ error: "User not found." });
      const kind: TokenKind = user.has_password ? "reset" : "invite";
      await store.deleteUserTokens(user.id, ["invite", "reset"]);
      res.json({ kind, link: linkFor(req, await issueToken(store, user.id, kind)) });
    }),
  );

  admin.patch(
    "/users/:id",
    route(async (req, res) => {
      const body = UpdateBody.parse(req.body);
      const target = await store.getUserRecord(Number(req.params.id));
      if (!target) return res.status(404).json({ error: "User not found." });
      if (target.email === ownerEmail && body.active === false) {
        return res.status(400).json({ error: "You can't disable your own account." });
      }
      const user = await store.updateUser(target.id, body);
      // Disabling someone signs them out everywhere straight away.
      if (body.active === false) await store.deleteUserTokens(target.id, ["session", "invite", "reset"]);
      res.json(user);
    }),
  );

  admin.delete(
    "/users/:id",
    route(async (req, res) => {
      const target = await store.getUserRecord(Number(req.params.id));
      if (!target) return res.status(404).json({ error: "User not found." });
      if (target.email === ownerEmail) return res.status(400).json({ error: "You can't remove your own account." });
      await store.deleteUser(target.id);
      res.status(204).end();
    }),
  );

  app.use("/api/admin", admin);

  return { requireUser, requireOwner };
}
