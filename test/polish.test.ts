import { test } from "node:test";
import assert from "node:assert/strict";
import { polishGeneration, polishMessage } from "../src/ai/polish.ts";

test("em and en dashes are removed", () => {
  assert.equal(polishMessage("Reza — early is when it matters."), "Reza, early is when it matters.");
  assert.equal(polishMessage("Fair enough–timing is everything"), "Fair enough, timing is everything");
  assert.equal(polishMessage("Totally fair —\nWhen works?"), "Totally fair.\n\nWhen works?");
  assert.ok(!/[—–]/.test(polishMessage("a—b – c — d")));
});

test("a single block is split into spaced lines, one thought each", () => {
  assert.equal(
    polishMessage("So sorry to hear that. We can absolutely reconnect when timing is better. When suits you?"),
    "So sorry to hear that.\n\nWe can absolutely reconnect when timing is better.\n\nWhen suits you?",
  );
});

test("existing line breaks become exactly one blank line", () => {
  assert.equal(polishMessage("Good morning Sam!\nHow are you?\n\n\n\nHoping we can reconnect."), "Good morning Sam!\n\nHow are you?\n\nHoping we can reconnect.");
  assert.equal(polishMessage("One line only"), "One line only");
});

test("numbers, decimals and links aren't split", () => {
  assert.equal(polishMessage("Owners with $2.5M in a holdco. Book here: https://cal.com/x.y"), "Owners with $2.5M in a holdco.\n\nBook here: https://cal.com/x.y");
});

test("polishGeneration cleans every reply and the notes", () => {
  const o = (m: string) => ({ label: "Curious", message: m, why: "Reframes — then asks." });
  const g = polishGeneration({ read: "Stall — not urgent.", intro_call: o("A. B."), leave_door_open: o("C"), continue_conversation: o("D — E?"), recommended: "intro_call" });
  assert.equal(g.intro_call.message, "A.\n\nB.");
  assert.equal(g.continue_conversation.message, "D, E?");
  assert.equal(g.read, "Stall, not urgent.");
  assert.equal(g.intro_call.why, "Reframes, then asks.");
});
