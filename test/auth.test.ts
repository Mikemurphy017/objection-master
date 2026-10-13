import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Store } from "../src/db.ts";
import { createApp, type AiBackend } from "../src/app.ts";
import { ensureOwner, hashPassword, verifyPassword } from "../src/auth.ts";
import { FsImageStore } from "../src/images.ts";
import { storeBackends, tmpDir } from "./helpers.ts";

const OWNER = "mike@bluestonepartnersllc.com";
const noAi = {} as AiBackend;

/** A tiny browser: remembers the session cookie between requests. */
function browser(base: string) {
  let cookie = "";
  async function req(path: string, init: RequestInit = {}) {
    const res = await fetch(base + path, {
      redirect: "manual",
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return res;
  }
  const send = (method: string, path: string, body?: unknown) =>
    req(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return {
    get: (path: string, headers: Record<string, string> = {}) => req(path, { headers }),
    post: (path: string, body?: unknown) => send("POST", path, body),
    patch: (path: string, body: unknown) => send("PATCH", path, body),
    del: (path: string) => send("DELETE", path),
    get cookie() {
      return cookie;
    },
  };
}

const tokenOf = (link: string) => link.split("#")[1];

test("passwords hash with a random salt and verify", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("correct horse battery", a));
  assert.ok(!(await verifyPassword("wrong", a)));
  assert.ok(!(await verifyPassword("anything", "not-a-hash")));
});

for (const backend of storeBackends) describe(`accounts (${backend.name})`, () => {
  let store: Store;
  let server: Server;
  let base: string;

  before(async () => {
    store = await backend.open();
    server = createApp(store, noAi, { auth: { ownerEmail: OWNER }, images: new FsImageStore(tmpDir()) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await store.close();
  });

  test("everything but sign-in needs a session", async () => {
    const anon = browser(base);
    assert.equal((await anon.get("/api/health")).status, 200);
    assert.equal((await anon.get("/api/clients")).status, 401);
    assert.equal((await anon.get("/api/admin/users")).status, 401);
    const page = await anon.get("/", { Accept: "text/html" });
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location")!, /^\/login\?next=/);
    assert.equal((await anon.get("/app.js")).status, 401);
    assert.equal((await anon.get("/login")).status, 200);
    assert.equal((await anon.get("/styles.css")).status, 200);
    assert.equal((await anon.get("/admin/", { Accept: "text/html" })).status, 302);
  });

  test("owner setup link, invites, resets, disabling and removal", async () => {
    // First boot: the owner exists with no password and gets a one-time setup link.
    const setup = await ensureOwner(store, OWNER.toUpperCase());
    assert.match(setup!, /^\/invite#/);
    const mike = browser(base);
    const info = await (await mike.get(`/api/auth/link/${tokenOf(setup!)}`)).json();
    assert.deepEqual(info, { email: OWNER, name: "", firstTime: true });
    assert.equal((await mike.post("/api/auth/accept", { token: tokenOf(setup!), password: "short" })).status, 400);
    assert.equal((await mike.post("/api/auth/accept", { token: tokenOf(setup!), password: "mike-password-1", name: "Mike" })).status, 200);
    assert.ok(mike.cookie.startsWith("om_session="));
    assert.equal(await ensureOwner(store, OWNER), null, "no new link once a password is set");
    assert.equal((await mike.post("/api/auth/accept", { token: tokenOf(setup!), password: "mike-password-2" })).status, 404, "link is one-time");

    const me = await (await mike.get("/api/me")).json();
    assert.equal(me.email, OWNER);
    assert.equal(me.isOwner, true);
    assert.equal(me.password_hash, undefined);
    assert.equal((await mike.get("/admin/", { Accept: "text/html" })).status, 200);

    // Invite a teammate.
    const invited = await mike.post("/api/admin/users", { email: " Sam@Example.com ", name: "Sam" });
    assert.equal(invited.status, 201);
    const { user: sam, link } = await invited.json();
    assert.equal(sam.email, "sam@example.com");
    assert.equal(sam.has_password, false);
    assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/invite#/);
    assert.equal((await mike.post("/api/admin/users", { email: "sam@example.com" })).status, 409);
    assert.equal((await mike.post("/api/admin/users", { email: "not-an-email" })).status, 400);

    const samB = browser(base);
    assert.equal((await samB.post("/api/auth/login", { email: "sam@example.com", password: "whatever-123" })).status, 401);
    assert.equal((await samB.post("/api/auth/accept", { token: tokenOf(link), password: "sam-password-1" })).status, 200);
    assert.equal((await samB.get("/api/clients")).status, 200);
    // Teammates can use the app but not the admin area.
    assert.equal((await samB.get("/api/admin/users")).status, 403);
    assert.equal((await samB.get("/admin/", { Accept: "text/html" })).status, 302);
    assert.equal((await (await samB.get("/api/me")).json()).isOwner, false);

    // Sign out and back in.
    await samB.post("/api/auth/logout");
    assert.equal((await samB.get("/api/clients")).status, 401);
    assert.equal((await samB.post("/api/auth/login", { email: "SAM@example.com", password: "sam-password-1" })).status, 200);

    const users = await (await mike.get("/api/admin/users")).json();
    assert.deepEqual(users.map((u: { email: string }) => u.email), [OWNER, "sam@example.com"]);
    const samRow = users.find((u: { email: string }) => u.email === "sam@example.com");
    assert.ok(samRow.last_login_at);
    assert.equal(samRow.password_hash, undefined);

    // Reset link: Sam sets a new password and every old session ends.
    const reset = await (await mike.post(`/api/admin/users/${sam.id}/link`)).json();
    assert.equal(reset.kind, "reset");
    const samPhone = browser(base);
    assert.equal((await samPhone.post("/api/auth/accept", { token: tokenOf(reset.link), password: "sam-password-2" })).status, 200);
    assert.equal((await samB.get("/api/clients")).status, 401, "old session ended by the reset");
    assert.equal((await samPhone.get("/api/clients")).status, 200);

    // Disable: signed out at once and can't sign back in; re-enable restores access.
    assert.equal((await mike.patch(`/api/admin/users/${sam.id}`, { active: false })).status, 200);
    assert.equal((await samPhone.get("/api/clients")).status, 401);
    assert.equal((await samPhone.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-2" })).status, 401);
    await mike.patch(`/api/admin/users/${sam.id}`, { active: true });
    assert.equal((await samPhone.post("/api/auth/login", { email: "sam@example.com", password: "sam-password-2" })).status, 200);

    // The owner can't lock themselves out.
    assert.equal((await mike.patch(`/api/admin/users/${me.id}`, { active: false })).status, 400);
    assert.equal((await mike.del(`/api/admin/users/${me.id}`)).status, 400);

    // Remove Sam entirely.
    assert.equal((await mike.del(`/api/admin/users/${sam.id}`)).status, 204);
    assert.equal((await samPhone.get("/api/clients")).status, 401);
    assert.equal((await (await mike.get("/api/admin/users")).json()).length, 1);

    // Changing your own password needs the current one.
    assert.equal((await mike.post("/api/me/password", { current: "nope", password: "mike-password-9" })).status, 400);
    assert.equal((await mike.post("/api/me/password", { current: "mike-password-1", password: "mike-password-9" })).status, 200);
    assert.equal((await mike.get("/api/me")).status, 200, "the device that changed it stays signed in");
  });

  test("ADMIN_PASSWORD sets the owner's first password and repeated failures are throttled", async () => {
    const other = await backend.open();
    try {
      assert.equal(await ensureOwner(other, "owner@example.com", "from-env-password"), null);
      const owner = await other.getUserByEmail("owner@example.com");
      assert.ok(owner && (await verifyPassword("from-env-password", owner.password_hash)));
    } finally {
      await other.close();
    }

    const b = browser(base);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await b.post("/api/auth/login", { email: "ghost@example.com", password: "wrong" })).status;
    assert.equal(last, 429);
  });
});
