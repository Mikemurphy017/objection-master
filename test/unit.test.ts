import { test } from "node:test";
import assert from "node:assert/strict";
import { matchClient, normalizeName } from "../src/match.ts";
import { splitSections, stripTimestamps } from "../src/corpus/ingest.ts";
import { Bm25Index } from "../src/corpus/retrieval.ts";
import { chunkText, type Client, type CorpusChunk } from "../src/db.ts";

const client = (id: number, name: string, extra: Partial<Client> = {}): Client => ({
  id,
  name,
  aliases: [],
  company: "",
  service_type: "",
  target_audience: "",
  tone: "",
  formality: "",
  style_notes: "",
  sample_messages: "",
  booking_link: "",
  created_at: "",
  updated_at: "",
  ...extra,
});

test("normalizeName strips designations, pronouns and headline tails", () => {
  assert.equal(normalizeName("Jane Doe, CFP®, ChFC (She/Her)"), "jane doe");
  assert.equal(normalizeName("José Álvarez | Wealth Advisor at Acme"), "jose alvarez");
});

test("matchClient resolves exact names, nicknames and aliases", () => {
  const clients = [client(1, "Michael Murphy"), client(2, "Sarah Chen", { aliases: ["Sarah Chen-Lopez"] }), client(3, "John Smith")];
  assert.equal(matchClient(["Mike Murphy"], clients).client?.id, 1);
  assert.equal(matchClient(["Sarah Chen-Lopez, CFP"], clients).client?.id, 2);
  assert.equal(matchClient(["john smith"], clients).client?.id, 3);
});

test("matchClient refuses weak or ambiguous matches", () => {
  const clients = [client(1, "John Smith"), client(2, "Jane Smith")];
  assert.equal(matchClient(["Jake Smith"], clients).client, null);
  assert.equal(matchClient(["Bob Jones"], clients).client, null);
  assert.equal(matchClient([null, ""], clients).client, null);
});

test("stripTimestamps removes transcript stamps", () => {
  assert.equal(stripTimestamps("so when 0:03 you're doing 1:02:33 outreach"), "so when you're doing outreach");
});

test("splitSections splits numbered Word headings, drops the TOC and duplicates", () => {
  const raw = [
    "Training Notes",
    "",
    "1 Cold Outreach Basics",
    "",
    "2 Follow Up",
    "",
    "1 Cold Outreach Basics",
    "",
    "so 0:01 when you reach 0:05 out to someone 0:09 be relevant 0:12 and connected 0:15 every time 0:20",
    "",
    "2 Follow Up",
    "",
    "follow 0:01 up with status 0:04 not neediness 0:07 always 0:10",
    "",
    "3 Follow Up Copy",
    "",
    "follow 0:01 up with status 0:04 not neediness 0:07 always 0:10",
  ].join("\n");
  const doc = splitSections(raw, "fallback");
  assert.equal(doc.title, "Training Notes");
  assert.deepEqual(
    doc.sections.map((s) => s.heading),
    ["1 Cold Outreach Basics", "2 Follow Up"],
  );
  assert.equal(doc.sections[0].text, "so when you reach out to someone be relevant and connected every time");
});

test("splitSections reads markdown headings and keeps intro text", () => {
  const doc = splitSections("# Playbook\n\nIntro line.\n\n## Frames\n\nHold the frame.", "x");
  assert.equal(doc.title, "Playbook");
  assert.deepEqual(doc.sections, [
    { heading: "Playbook", text: "Intro line." },
    { heading: "Frames", text: "Hold the frame." },
  ]);
});

test("chunkText makes overlapping chunks", () => {
  const words = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks[1].startsWith("w240 "));
  assert.ok(chunks.at(-1)!.endsWith("w699"));
});

test("Bm25Index ranks relevant chunks first and limits per section", () => {
  const mk = (id: number, heading: string, text: string): CorpusChunk => ({
    id,
    document_id: 1,
    document_title: "Doc",
    heading,
    text,
  });
  const index = new Bm25Index([
    mk(1, "Pricing", "when the buyer asks about price, anchor on value before cost"),
    mk(2, "Scheduling", "offer two calendar windows for the meeting, tuesday or thursday"),
    mk(3, "Scheduling", "assistant scheduling calendar meeting confirm"),
    mk(4, "Scheduling", "calendar meeting reschedule calendar"),
    mk(5, "Status", "never chase, hold the frame"),
  ]);
  const hits = index.search("can we find time on the calendar for a meeting", 5, 2);
  assert.equal(hits[0].chunk.heading, "Scheduling");
  assert.equal(hits.filter((h) => h.chunk.heading === "Scheduling").length, 2);
});
