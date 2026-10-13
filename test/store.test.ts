import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/db.ts";
import { storeBackends } from "./helpers.ts";

const clientInput = (name: string) => ({
  name,
  aliases: ["Alias One"],
  company: "Acme",
  service_type: "",
  target_audience: "",
  tone: "",
  formality: "",
  style_notes: "",
  sample_messages: "",
  booking_link: "",
  country: "",
});

const turnInput = (clientId: number, objection: string) => ({
  client_id: clientId,
  objection_text: objection,
  prospect_name: "Dana",
  thread_context: "",
  guidance: "",
  image: "",
  result: { read: "r", recommended: "intro_call", intro_call: { message: "m" } },
  sources: [{ document: "Doc", section: "S" }],
});

const doc = (text: string) => ({ title: "Doc", sections: [{ heading: "H", text }] });
const TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

// The same contract for every Store implementation (Postgres only when TEST_DATABASE_URL is set).
for (const backend of storeBackends) describe(`Store contract (${backend.name})`, () => {
  let store: Store;
  before(async () => {
    store = await backend.open();
  });
  after(() => store.close());

  test("clients, turns and favorites keep their shapes and delete rules", async () => {
    const a = await store.createClient(clientInput("beta"));
    const b = await store.createClient(clientInput("Alpha"));
    assert.deepEqual(a.aliases, ["Alias One"]);
    assert.match(a.created_at, TIMESTAMP);
    assert.deepEqual((await store.listClients()).map((c) => c.name), ["Alpha", "beta"]);
    assert.equal((await store.updateClient(a.id, { ...clientInput("Beta"), company: "New" }))?.company, "New");
    assert.equal(await store.updateClient(9999, clientInput("x")), undefined);

    const turn = await store.addTurn(turnInput(a.id, "too busy"));
    assert.deepEqual(turn.result, turnInput(a.id, "").result);
    assert.deepEqual(Object.keys(turn.result as object), ["read", "recommended", "intro_call"], "JSON key order kept");
    assert.deepEqual(turn.sources, [{ document: "Doc", section: "S" }]);
    assert.match(turn.created_at, TIMESTAMP);
    const fav = await store.addFavorite({
      client_id: a.id,
      strategy: "intro_call",
      objection_text: "too busy",
      response_text: "reply",
      prospect_name: "",
      generation_id: turn.id,
    });
    assert.equal(fav.generation_id, turn.id);

    const convos = await store.listConversations();
    assert.deepEqual(convos.map((c) => [c.client_id, c.turns]), [[a.id, 1], [b.id, 0]]);
    assert.equal(typeof convos[0].turns, "number");
    assert.match(convos[0].last_at!, TIMESTAMP);
    assert.equal(convos[1].last_at, null);

    // Deleting a turn unlinks its favorite (SET NULL) but keeps it.
    assert.equal((await store.deleteTurn(turn.id))?.id, turn.id);
    assert.equal(await store.deleteTurn(turn.id), undefined);
    assert.equal((await store.listFavorites(a.id))[0].generation_id, null);

    // Deleting a client cascades to favorites and orphans its turns (SET NULL).
    const kept = await store.addTurn(turnInput(a.id, "no budget"));
    assert.equal(await store.deleteClient(a.id), true);
    assert.equal(await store.deleteClient(a.id), false);
    assert.equal((await store.listFavorites(a.id)).length, 0);
    assert.equal((await store.getTurn(kept.id))?.client_id, null);
    assert.equal(await store.deleteFavorite(fav.id), false);
  });

  test("corpus upserts by content hash and bumps corpusVersion", async () => {
    const v0 = store.corpusVersion;
    const opts = { filename: "a.md", source: "repo" as const, pinned: false };
    assert.equal(await store.upsertDocument(doc("one two three"), opts), true);
    assert.equal(await store.upsertDocument(doc("one two three"), opts), false, "unchanged content is a no-op");
    assert.equal(store.corpusVersion, v0 + 1);
    assert.equal(await store.upsertDocument(doc("one two three four"), opts), true);
    assert.equal(await store.upsertDocument(doc("x"), { ...opts, filename: "core-b.md", pinned: true }), true);
    await store.upsertDocument(doc("uploaded words"), { filename: "upload:c.md", source: "upload", pinned: false });

    const docs = await store.listDocuments();
    assert.deepEqual(docs.map((d) => [d.filename, d.pinned]), [["core-b.md", true], ["a.md", false], ["upload:c.md", false]]);
    assert.equal(docs[1].word_count, 4);
    assert.equal(docs[1].chunk_count, 1);
    assert.equal((await store.chunks(true)).length, 1);
    assert.deepEqual((await store.chunks(false)).map((c) => c.text), ["one two three four", "uploaded words"]);

    const before = store.corpusVersion;
    await store.pruneRepoDocuments(["core-b.md"]);
    assert.equal(store.corpusVersion, before + 1);
    assert.equal(await store.deleteDocument(docs[0].id), false, "repo docs can't be deleted");
    assert.equal(await store.deleteDocument(docs[2].id), true);
    assert.deepEqual((await store.listDocuments()).map((d) => d.filename), ["core-b.md"]);
    assert.equal((await store.chunks(false)).length, 0, "chunks cascade with their document");
  });
});
