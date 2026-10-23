import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore, type Store } from "../src/db.ts";
import { createApp, syncRepoCorpus, type AiBackend } from "../src/app.ts";
import { FsImageStore } from "../src/images.ts";
import type { GenerateInput } from "../src/ai/generate.ts";
import { imageBackends, storeBackends, tmpDir } from "./helpers.ts";

let lastGenerateInput: GenerateInput | null = null;
let lastExtractClient: string | null = null;

const fakeAi: AiBackend = {
  async extract(_image, clientName) {
    lastExtractClient = clientName;
    return {
      prospect_name: "Dana Lee",
      prospect_headline: "Partner at Lee Wealth",
      prospect_location: "Toronto, Canada",
      objection_text: "We already work with an agency for LinkedIn.",
      thread_context: "Michael Murphy: Saw your post on RSU planning...",
      channel: "linkedin" as const,
      notes: "",
    };
  },
  async generate(input) {
    lastGenerateInput = input;
    const option = (m: string) => ({ label: "Curious", message: m, why: "because" });
    return {
      read: "Not in pain.",
      intro_call: option("call?"),
      leave_door_open: option("door"),
      continue_conversation: option("question?"),
      recommended: "continue_conversation" as const,
    };
  },
};

// Every store runs the full API suite; SQLite also runs it with the S3 image store (fake client).
const combos = storeBackends.flatMap((store) =>
  (store.name === "sqlite" ? imageBackends : imageBackends.slice(0, 1)).map((images) => ({ store, images })),
);

for (const combo of combos) describe(`API (${combo.store.name} + ${combo.images.name})`, () => {
  let server: Server;
  let base: string;
  let store: Store;

  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  before(async () => {
    store = await combo.store.open();
    await syncRepoCorpus(store);
    // Accounts are covered in auth.test.ts; here we exercise the API itself.
    server = createApp(store, fakeAi, { auth: false, images: combo.images.open() }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await store.close();
  });

  test("full flow: add client, analyze screenshot, generate, favorite, reuse", async () => {
    const created = await post("/api/clients", {
      name: "Michael Murphy",
      aliases: "Mike M., Michael J. Murphy",
      company: "Bluestone Partners",
      service_type: "Wealth management",
      tone: "Dry, confident",
    });
    assert.equal(created.status, 201);
    const client = await created.json();
    assert.deepEqual(client.aliases, ["Mike M.", "Michael J. Murphy"]);

    // Analyze from this client's chat: the reader is told whose account it is.
    const form = new FormData();
    form.append("screenshot", new Blob([Buffer.from("fake-png")], { type: "image/png" }), "shot.png");
    form.append("clientId", String(client.id));
    const analyzed = await (await fetch(base + "/api/analyze", { method: "POST", body: form })).json();
    assert.equal(analyzed.clientId, client.id);
    assert.equal(lastExtractClient, "Michael Murphy");
    assert.equal(analyzed.extraction.objection_text, "We already work with an agency for LinkedIn.");

    // Generate: client context, core playbook and retrieved excerpts all reach the model.
    const gen = await post("/api/generate", { clientId: client.id, objection: analyzed.extraction.objection_text });
    assert.equal(gen.status, 200);
    const genBody = await gen.json();
    assert.equal(genBody.result.recommended, "continue_conversation");
    assert.equal(lastGenerateInput!.client.service_type, "Wealth management");
    assert.ok(lastGenerateInput!.coreStyle.length > 5, "core playbook loaded");
    assert.ok(lastGenerateInput!.excerpts.length > 0, "transcript excerpts retrieved");
    assert.equal(lastGenerateInput!.favorites.length, 0);

    // The turn is saved to the client's chat history along with its screenshot.
    assert.match(analyzed.imageId, /^[a-f0-9]{32}\.png$/);
    const turnRes = await post("/api/generate", {
      clientId: client.id,
      objection: "We already work with an agency",
      prospectName: "Dana Lee",
      imageId: analyzed.imageId,
    });
    const turn = await turnRes.json();
    assert.equal(turn.image, analyzed.imageId);
    const img = await fetch(`${base}/api/images/${turn.image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await img.arrayBuffer()).toString(), "fake-png");
    assert.equal((await fetch(`${base}/api/images/..%2Fsecret.png`)).status, 404);
    assert.equal((await post("/api/generate", { clientId: client.id, objection: "x", imageId: "../etc/passwd" })).status, 400);

    // Favorite one, and it is fed back into the next generation as style signal.
    const fav = await post("/api/favorites", {
      clientId: client.id,
      strategy: "leave_door_open",
      objection: "We already work with an agency",
      response: "Then you're probably covered.",
      turnId: turn.id,
    });
    assert.equal(fav.status, 201);
    assert.equal((await fav.json()).generation_id, turn.id);

    const history = await (await fetch(`${base}/api/clients/${client.id}/turns`)).json();
    assert.equal(history.turns.length, 2);
    assert.equal(history.turns[1].prospect_name, "Dana Lee");
    assert.equal(history.favorites[0].generation_id, turn.id);
    const convos = await (await fetch(`${base}/api/conversations`)).json();
    assert.equal(convos[0].client_id, client.id);
    assert.equal(convos[0].turns, 2);

    // Deleting a turn removes its screenshot; the saved reply survives, unlinked.
    assert.equal((await fetch(`${base}/api/turns/${turn.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/images/${turn.image}`)).status, 404);
    const favs = await (await fetch(`${base}/api/clients/${client.id}/favorites`)).json();
    assert.equal(favs.length, 1);
    assert.equal(favs[0].generation_id, null);
    assert.match(favs[0].created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    await post("/api/generate", { clientId: client.id, objection: "too busy" });
    assert.equal(lastGenerateInput!.favorites[0].response_text, "Then you're probably covered.");

    // Edit, then delete (favorites cascade).
    const edited = await fetch(`${base}/api/clients/${client.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...client, service_type: "Retirement planning" }),
    });
    assert.equal((await edited.json()).service_type, "Retirement planning");
    assert.equal((await fetch(`${base}/api/clients/${client.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await (await fetch(`${base}/api/clients/${client.id}/favorites`)).json()).length, 0);
  });

  test("screenshots always go to the chat's client; without one they're refused", async () => {
    await post("/api/clients", { name: "Priya Patel" });
    const priya = (await (await fetch(base + "/api/clients")).json()).find((c: { name: string }) => c.name === "Priya Patel");
    const shot = (clientId?: string) => {
      const form = new FormData();
      form.append("screenshot", new Blob([Buffer.from("x")], { type: "image/png" }), "shot.png");
      if (clientId) form.append("clientId", clientId);
      return fetch(base + "/api/analyze", { method: "POST", body: form });
    };
    const analyzed = await (await shot(String(priya.id))).json();
    assert.equal(analyzed.clientId, priya.id);
    assert.equal(lastExtractClient, "Priya Patel");
    assert.equal((await shot()).status, 400, "no client chosen");
    assert.equal((await shot("999999")).status, 400, "unknown client");
  });

  test("validation errors are readable", async () => {
    const res = await post("/api/clients", { name: "" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Name is required/);
    const bad = await fetch(base + "/api/analyze", { method: "POST", body: new FormData() });
    assert.equal(bad.status, 400);
  });

  test("corpus upload adds a searchable document that can be removed", async () => {
    const form = new FormData();
    form.append("file", new Blob(["# Extra\n\n## Pricing\n\nAnchor high, then narrow."], { type: "text/markdown" }), "extra.md");
    const res = await fetch(base + "/api/corpus", { method: "POST", body: form });
    assert.equal(res.status, 201);
    const docs = await res.json();
    const uploaded = docs.find((d: { title: string }) => d.title === "Extra");
    assert.ok(uploaded);
    assert.ok(docs.some((d: { pinned: boolean }) => d.pinned), "core playbook present");
    assert.equal((await fetch(`${base}/api/corpus/${uploaded.id}`, { method: "DELETE" })).status, 204);
    const builtIn = docs.find((d: { source: string }) => d.source === "repo");
    assert.equal((await fetch(`${base}/api/corpus/${builtIn.id}`, { method: "DELETE" })).status, 404);
  });

});

test("a broken screenshot store (e.g. rotated bucket keys) never blocks replies", async () => {
  const store = new SqliteStore(":memory:");
  const denied = () => Promise.reject(new Error("SignatureDoesNotMatch"));
  const images = Object.assign(new FsImageStore(tmpDir()), { save: denied, exists: denied });
  const server = createApp(store, fakeAi, { auth: false, images }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const client = await store.createClient({
      name: "Gil Mauro", aliases: [], company: "", service_type: "", target_audience: "", tone: "", formality: "",
      style_notes: "", sample_messages: "", booking_link: "", country: "", bio: "",
    });
    const form = new FormData();
    form.append("screenshot", new Blob([Buffer.from("fake-png")], { type: "image/png" }), "shot.png");
    form.append("clientId", String(client.id));
    const analyzed = await fetch(base + "/api/analyze", { method: "POST", body: form });
    assert.equal(analyzed.status, 200);
    const body = await analyzed.json();
    assert.equal(body.imageId, "");
    assert.equal(body.extraction.objection_text, "We already work with an agency for LinkedIn.");

    const gen = await fetch(base + "/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.id, objection: "Not interested", imageId: `${"a".repeat(32)}.png` }),
    });
    assert.equal(gen.status, 200);
    assert.ok(errors.length >= 1, "the storage failure is logged");
  } finally {
    console.error = origError;
    server.close();
    await store.close();
  }
});
