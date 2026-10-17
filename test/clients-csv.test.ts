import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { parseCsv, planImport, fillBlanks, TEMPLATE_CSV } from "../src/clients-csv.ts";
import { SqliteStore, type Client } from "../src/db.ts";
import { createApp, type AiBackend } from "../src/app.ts";
import { FsImageStore } from "../src/images.ts";
import { tmpDir } from "./helpers.ts";

const stored = (id: number, name: string, extra: Partial<Client> = {}): Client => ({
  id, name, aliases: [], company: "", service_type: "", target_audience: "", tone: "", formality: "",
  style_notes: "", sample_messages: "", booking_link: "", country: "", bio: "", created_at: "", updated_at: "", ...extra,
});

test("parseCsv handles quotes, embedded commas/newlines, CRLF, BOM and semicolons", () => {
  assert.deepEqual(parseCsv('﻿Name,Notes\r\n"Doe, Jane","line one\nline ""two"""\r\nSam,\r\n\r\n'), [
    ["Name", "Notes"],
    ["Doe, Jane", 'line one\nline "two"'],
    ["Sam", ""],
  ]);
  assert.deepEqual(parseCsv("Name;Firm\nAna;Acme"), [["Name", "Firm"], ["Ana", "Acme"]]);
  assert.deepEqual(parseCsv("Name\tFirm\nAna\tAcme"), [["Name", "Firm"], ["Ana", "Acme"]]);
});

test("planImport maps common headers, leaves the rest blank, and flags what's missing", () => {
  const csv = [
    "Client Name,Firm,Industry,Calendly,Formality,AKA,Favourite colour",
    "Jane Doe,Doe Wealth,Wealth management,calendly.com/jane,casual,Janie D; J. Doe,Blue",
    ",No Name Co,,,,,",
    "Mike Murphy,Bluestone,,,,,",
    "jane doe,Duplicate Row,,,,,",
  ].join("\n");
  const plan = planImport(csv, [stored(7, "Michael Murphy", { company: "", tone: "Dry" })]);

  assert.deepEqual(
    plan.columns.map((c) => c.field),
    ["name", "company", "service_type", "booking_link", "formality", "aliases", null],
  );
  const [jane, noName, mike, dup] = plan.rows;
  assert.equal(jane.status, "new");
  assert.equal(jane.line, 2);
  assert.deepEqual(jane.client.aliases, ["Janie D", "J. Doe"]);
  assert.equal(jane.client.formality, "Casual", "normalised to the dropdown's spelling");
  assert.equal(jane.client.booking_link, "https://calendly.com/jane");
  assert.equal(jane.client.tone, "", "columns the CSV doesn't have stay blank");
  assert.deepEqual(jane.missing, ["target_audience", "tone", "style_notes", "sample_messages", "country", "bio"]);

  assert.equal(noName.status, "invalid");
  assert.equal(mike.status, "existing", "nickname matches the stored client");
  assert.equal(mike.existingId, 7);
  assert.deepEqual(mike.fillable, ["company"]);
  assert.equal(dup.status, "duplicate");
  assert.deepEqual(plan.counts, { new: 1, existing: 1, duplicate: 1, invalid: 1 });
});

test("planImport understands the app's own long form labels as headers", () => {
  const csv =
    'Name (as it appears on LinkedIn),Other names / spellings,Company,Country (where they\'re based),Service type,Who they target,Tone,Formality,"Phrasing preferences, do\'s and don\'ts"\n' +
    'Jason Kelso,,Merrill Lynch,United States,Exit planning,"Business Owners\nFounders",Consultative,,Lead with questions\n';
  const plan = planImport(csv, []);
  assert.deepEqual(plan.columns.map((c) => c.field), [
    "name", "aliases", "company", "country", "service_type", "target_audience", "tone", "formality", "style_notes",
  ]);
  assert.equal(plan.rows[0].client.target_audience, "Business Owners\nFounders");
  assert.equal(plan.rows[0].client.style_notes, "Lead with questions");
});

test("planImport reads a country column", () => {
  const plan = planImport("Name,Based in\nRachelle Allen,Canada\n", []);
  assert.equal(plan.columns[1].field, "country");
  assert.equal(plan.rows[0].client.country, "Canada");
});

test("planImport reads a bio column", () => {
  const plan = planImport("Name,Credentials\nAna Lopez,\"CFP, CFA\"\n", []);
  assert.equal(plan.columns[1].field, "bio");
  assert.equal(plan.rows[0].client.bio, "CFP, CFA");
});

test("planImport combines first and last name columns and rejects files without names", () => {
  const plan = planImport("First Name,Last Name,Company\nAna,Lopez,Acme\n", []);
  assert.equal(plan.rows[0].client.name, "Ana Lopez");
  assert.throws(() => planImport("Company,Industry\nAcme,Wealth\n", []), /No name column/);
  assert.throws(() => planImport("Name\n", []), /at least one client/);
});

test("fillBlanks never overwrites what's already there", () => {
  const merged = fillBlanks(
    stored(1, "Ana", { company: "Kept Co", tone: "" }),
    { ...stored(0, "Ana", { company: "New Co", tone: "Warm", aliases: ["A"] }) },
    ["company", "tone", "aliases"],
  );
  assert.equal(merged.company, "Kept Co");
  assert.equal(merged.tone, "Warm");
  assert.deepEqual(merged.aliases, ["A"]);
});

test("the template parses as a valid import", () => {
  const plan = planImport(TEMPLATE_CSV, []);
  assert.equal(plan.rows[0].status, "new");
  assert.ok(plan.columns.every((c) => c.field), "every template column is recognised");
});

test("import endpoint previews, then creates new clients and fills blanks on request", async () => {
  const store = new SqliteStore(":memory:");
  await store.createClient({ ...stored(0, "Michael Murphy"), company: "", tone: "Dry" });
  const server = createApp(store, {} as AiBackend, { auth: false, images: new FsImageStore(tmpDir()) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (fields: Record<string, string>) => {
    const form = new FormData();
    form.append("file", new Blob(["Name,Company,Tone\nJane Doe,Doe Wealth,\nMike Murphy,Bluestone,Warm\n"], { type: "text/csv" }), "clients.csv");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${base}/api/clients/import`, { method: "POST", body: form });
  };
  try {
    const preview = await (await send({})).json();
    assert.equal(preview.committed, false);
    assert.equal((await store.listClients()).length, 1, "preview changes nothing");

    const done = await (await send({ commit: "true", fillBlanks: "true" })).json();
    assert.equal(done.created, 1);
    assert.equal(done.updated, 1);
    const clients = await store.listClients();
    const jane = clients.find((c) => c.name === "Jane Doe")!;
    assert.equal(jane.company, "Doe Wealth");
    assert.equal(jane.tone, "");
    const mike = clients.find((c) => c.name === "Michael Murphy")!;
    assert.equal(mike.company, "Bluestone", "blank field filled");
    assert.equal(mike.tone, "Dry", "existing value kept");

    const again = await (await send({ commit: "true" })).json();
    assert.equal(again.created, 0, "re-importing the same file creates no duplicates");

    const tpl = await fetch(`${base}/api/clients/import-template.csv`);
    assert.match(tpl.headers.get("content-disposition")!, /clients-template\.csv/);
    const bad = new FormData();
    bad.append("file", new Blob(["Company\nAcme\n"]), "x.csv");
    assert.equal((await fetch(`${base}/api/clients/import`, { method: "POST", body: bad })).status, 400);
  } finally {
    server.close();
    await store.close();
  }
});
