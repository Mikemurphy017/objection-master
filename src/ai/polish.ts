import type { Generation } from "./generate.ts";

/**
 * House formatting, enforced after the model writes (TextTonality): no em or en
 * dashes, and every thought on its own line with a blank line between, so a
 * reply never lands as one block of text on a phone.
 */
export function polishMessage(text: string): string {
  let t = text
    .replace(/\r\n?/g, "\n")
    // A dash at the end of a line reads as a pause: make it a full stop.
    .replace(/[ \t]*[—–][ \t]*(?=\n|$)/g, ".")
    // Dashes between words become commas.
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  // One block of several sentences: give each sentence its own line.
  if (!t.includes("\n")) t = t.split(/(?<=[.!?])\s+(?=["'“‘(]?[A-Z0-9])/).join("\n");
  // Each line break becomes a blank line (Shift+Enter spacing), never more than one.
  return t
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Dashes out of the team-facing notes too; spacing only matters in the replies. */
const undash = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*([.!?])/g, "$1");

export function polishGeneration(g: Generation): Generation {
  const option = (o: Generation["intro_call"]) => ({ label: undash(o.label), message: polishMessage(o.message), why: undash(o.why) });
  return {
    ...g,
    read: undash(g.read),
    intro_call: option(g.intro_call),
    leave_door_open: option(g.leave_door_open),
    continue_conversation: option(g.continue_conversation),
  };
}
