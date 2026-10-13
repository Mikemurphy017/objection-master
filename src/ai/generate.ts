import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Client, CorpusChunk, Favorite, Strategy } from "../db.ts";
import { FALLBACK_PARAMS, GenerationError, MODEL, describeApiError, getClient } from "./claude.ts";

const OptionSchema = z.object({
  label: z.string().describe("One- or two-word tag for the move, e.g. Curious, Takeaway, Straight."),
  message: z.string().describe("The reply exactly as it will be sent. Plain text, no quotes, no markdown."),
  why: z.string().describe("One short sentence for the team on why this move fits."),
});

export const GenerationSchema = z.object({
  read: z.string().describe("One sentence: what the objection actually means (the subtext)."),
  intro_call: OptionSchema,
  leave_door_open: OptionSchema,
  continue_conversation: OptionSchema,
  recommended: z.enum(["intro_call", "leave_door_open", "continue_conversation"]),
});

export type Generation = z.infer<typeof GenerationSchema>;

export interface GenerateInput {
  client: Client;
  objection: string;
  threadContext?: string;
  prospectName?: string | null;
  prospectHeadline?: string | null;
  channel?: string;
  /** Free-text steer from the team, e.g. "shorter" or "mention the webinar". */
  guidance?: string;
  favorites: Favorite[];
  coreStyle: CorpusChunk[];
  excerpts: CorpusChunk[];
}

export const STRATEGY_LABELS: Record<Strategy, string> = {
  intro_call: "Move to an intro call",
  leave_door_open: "Leave the door open",
  continue_conversation: "Continue the conversation",
};

const INSTRUCTIONS = `You write replies to prospect objections for an outbound agency that runs LinkedIn (and sometimes email) outreach on behalf of its clients. Every reply is sent from the client's own account, in the client's voice, to the prospect. Write in Oren Klaff's style as captured in the playbook and source excerpts: high-status, calm, never chasing, intrigue over information, fluent in the prospect's world, human.

For each objection you write exactly three replies, each with a different strategic goal:

1. intro_call - Move to an intro call. Steer the conversation toward booking an introductory call. Give the prospect a reason the call is worth it for THEM, make the ask feel small and casual, and vary how it's phrased (two concrete windows, "when's easier", etc.). Don't default to "15 minutes".
2. leave_door_open - Leave the door open. Keep the relationship warm without pushing. A graceful takeaway, zero neediness, and something (a timing hook, a pattern worth remembering) that gives them an easy reason to re-engage later. No ask for time.
3. continue_conversation - Continue the conversation. Use precise, casual industry lingo from the prospect's world (and the client's service area) plus an insider observation, then pivot the conversation forward with a question they have to think about to answer. Must end on that question.

The three must be genuinely different moves with different shapes, not three wordings of one message.

Keep it light. These are LinkedIn DMs, not memos:
- 2 to 4 short sentences, roughly 25 to 60 words. Shorter is better. If the prospect wrote one line, answer in one or two.
- One idea per reply. At most one or two industry terms, used casually; never stack jargon or acronyms in a sentence.
- Plain words, easy to read on a phone. No lists, no slashes, no parentheticals, no em-dash chains.
- No links unless the client has a booking link and the reply is intro_call, and even then only if it reads naturally. Don't name specific dates, times or time zones; offer a loose window ("early next week") or ask what works.

Country fit (important):
- Write for the country the CLIENT is based in, and the prospect's location if it's known. Use that country's accounts, tax rules, regulators and everyday terms.
- Never use another country's concepts. For a Canadian client: think RRSP, TFSA, RESP, FHSA, RRIF, holdco, CCPC, lifetime capital gains exemption, estate freeze, family trust, IPP, CRA, CIRO; never US-only ideas such as QSBS, 83(b), 409A, 401(k), IRA, Roth, S-corp or IRS. For a UK client: ISA, SIPP, pension drawdown, IHT, BADR, EMI options, HMRC, FCA. For a US client, US terms are fine.
- If the client's country isn't specified, avoid country-specific accounts, tax rules and laws altogether and stay with universal ideas.

Voice and client fit:
- Shape every reply to the client's messaging-style preferences (tone, formality, phrasing notes, sample messages). Where the client's preferences and the playbook disagree on surface style (formality, length, punctuation), the client wins. The Klaff strategy underneath stays.
- Use the client's service type to decide what's being offered and which lingo is natural. Most clients are in financial services: follow the compliance hard rules (no performance promises, no investment advice, no product recommendations).
- Saved favorites for this client are replies the team has already approved. Treat them as the strongest signal of the client's voice. Echo their style, never copy them verbatim.
- Use the prospect's real first name only if it's known and the client's style uses names. No placeholders unless unavoidable, and then in [square brackets].
- Mirror the prospect's register and length. A flat "no" / "stop messaging me" gets one graceful line for every option, and intro_call becomes a no-pressure line that still leaves the option of talking.
- Never invent results, clients, statistics or scarcity. Never name Klaff, his books or his frameworks. Never quote the excerpts.

Also return "read" (one sentence on the subtext of the objection) and "recommended" (the one of the three you'd send right now).`;

function formatClient(c: Client): string {
  const lines = [
    `Name: ${c.name}`,
    `Country (where the client is based): ${c.country || "not specified: avoid country-specific accounts, tax rules and laws"}`,
    c.company && `Company: ${c.company}`,
    `Service type: ${c.service_type || "(not specified; most clients are in financial services)"}`,
    c.target_audience && `Who they target: ${c.target_audience}`,
    c.tone && `Tone: ${c.tone}`,
    c.formality && `Formality: ${c.formality}`,
    c.style_notes && `Phrasing preferences / do's and don'ts:\n${c.style_notes}`,
    c.sample_messages && `Sample messages in their voice:\n${c.sample_messages}`,
    c.booking_link && `Booking link (intro_call only, and only if it reads naturally): ${c.booking_link}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function formatFavorites(favs: Favorite[]): string {
  if (!favs.length) return "None saved yet.";
  return favs
    .map(
      (f, i) =>
        `<favorite index="${i + 1}" goal="${f.strategy}">\n<objection>${f.objection_text}</objection>\n<reply>${f.response_text}</reply>\n</favorite>`,
    )
    .join("\n");
}

function formatExcerpts(chunks: CorpusChunk[]): string {
  if (!chunks.length) return "None retrieved.";
  return chunks
    .map((c) => `<excerpt source="${c.document_title}" section="${c.heading}">\n${c.text}\n</excerpt>`)
    .join("\n");
}

export function buildSystem(coreStyle: CorpusChunk[]): string {
  const playbook = coreStyle.map((c) => `## ${c.heading}\n\n${c.text}`).join("\n\n");
  return `${INSTRUCTIONS}\n\n<klaff_playbook>\n${playbook}\n</klaff_playbook>`;
}

export function buildUserPrompt(input: GenerateInput): string {
  const prospect = [input.prospectName, input.prospectHeadline].filter(Boolean).join(" - ") || "Unknown";
  return `<client_profile>
${formatClient(input.client)}
</client_profile>

<saved_favorites_for_this_client>
${formatFavorites(input.favorites)}
</saved_favorites_for_this_client>

<klaff_source_excerpts>
${formatExcerpts(input.excerpts)}
</klaff_source_excerpts>

<conversation channel="${input.channel || "linkedin"}">
<prospect>${prospect}</prospect>
<earlier_messages>
${input.threadContext?.trim() || "(none visible)"}
</earlier_messages>
<objection>
${input.objection.trim()}
</objection>
</conversation>
${input.guidance?.trim() ? `\n<team_guidance>${input.guidance.trim()}</team_guidance>\n` : ""}
Write the three replies.`;
}

export async function generateResponses(input: GenerateInput): Promise<Generation> {
  try {
    const response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK_PARAMS,
      output_config: {
        effort: (process.env.GENERATION_EFFORT as "low" | "medium" | "high" | undefined) || "medium",
        format: betaZodOutputFormat(GenerationSchema),
      },
      // The instructions + playbook are identical on every request; cache them.
      system: [{ type: "text", text: buildSystem(input.coreStyle), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });
    if (response.stop_reason === "refusal") {
      throw new GenerationError("Claude declined to answer this one. Try rewording the objection text.");
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new GenerationError("The response came back incomplete. Try again.");
    }
    return response.parsed_output;
  } catch (err) {
    throw describeApiError(err);
  }
}
