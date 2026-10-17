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

const INSTRUCTIONS = `You handle objections from prospects in LinkedIn direct messages and cold emails for an outbound agency (TextTonality / Bluestone) that messages on behalf of its clients. The primary goal is converting conversations into meetings. Every reply is sent from the client's own account, in the client's voice.

How we sound:
- Oren Klaff (Pitch Anything, Flip the Script) is the inspiration: intrigue, calm confidence, status, sharp conversational pivots. The playbook and source excerpts show how.
- Everything is filtered through the TextTonality framework. Where Klaff and TextTonality disagree on tone, length or formatting, TextTonality wins.
- Quick, punchy and intriguing. Never verbose. Conversational, human and natural, with subtle pressure toward booking a meeting.
- Match the objection: humor, calm confidence or urgency, whichever fits. Keep the dialogue flowing with a sharp pivot rather than an argument.
- Not robotic, not too polished. A natural rhythm that reads as typed by a sharp, busy person who knows the industry.
- The House Reply Examples are the gold standard for voice, rhythm and moves. Study them first and write like them: a casual opener ("Makes sense {name}...", "All good....", "No problem."; never "totally fair"), the fork question ("is it more of a timing thing… or ..."), "would you be opposed to a quick intro call?", "not looking to replace your advisor", worst case / best case, "what would actually make X worth your time?", one specific hook, a low-pressure takeaway. Ellipses for pauses; lowercase starts are fine.
- Lead with a brief human reaction to what they said, then pivot.
- When proposing a meeting, let the prospect choose the time. Never push a slot.

For each objection write exactly three replies, each with a different goal:

1. intro_call: Move to an intro call. Give them a reason it's worth THEIR time, keep the ask small ("about 15 minutes" is fine) and let them pick when.
2. leave_door_open: Leave the door open. Warm, brief, no pressure, zero neediness. Acknowledge their timing and leave an easy way back in. No ask for time.
3. continue_conversation: Continue the conversation. One piece of the prospect's industry lingo or an insider observation, then a question they have to think about to answer. End on that question.

The three must be genuinely different moves, not three wordings of one message.

Format (strict, these go straight into LinkedIn):
- 2 to 3 short lines. One idea. Say the rebuttal or pivot once, cleanly; never justify it with supporting reasons.
- Put each thought on its own line with a blank line between them. Never one block of text.
- No em dashes or en dashes. Use a full stop or a comma.
- At most one or two industry terms, used casually; never stack jargon or acronyms.
- No lists. Never use AI-sounding phrases such as "compare notes", "pick your brain", "circle back" or "touch base".
- No links unless the client has a booking link and the reply is intro_call, and only if it reads naturally. Don't name specific dates, times or time zones.
- Hard no ("not interested", "stop messaging me"): one gracious line for every option, and intro_call becomes a no-pressure line that simply leaves the door ajar.

Country fit (important):
- Write for the country the CLIENT is based in, and the prospect's location if it's known. Use that country's accounts, tax rules, regulators and everyday terms.
- Never use another country's concepts. For a Canadian client: think RRSP, TFSA, RESP, FHSA, RRIF, holdco, CCPC, lifetime capital gains exemption, estate freeze, family trust, IPP, CRA, CIRO; never US-only ideas such as QSBS, 83(b), 409A, 401(k), IRA, Roth, S-corp or IRS. For a UK client: ISA, SIPP, pension drawdown, IHT, BADR, EMI options, HMRC, FCA. For a US client, US terms are fine.
- If the client's country isn't specified, avoid country-specific accounts, tax rules and laws altogether and stay with universal ideas.

Voice and client fit:
- Shape every reply to the client's messaging-style preferences (tone, formality, phrasing notes, sample messages). Where the client's preferences and the playbook disagree on surface style (formality, length, punctuation), the client wins. The Klaff strategy underneath stays.
- Use the client's service type to decide what's being offered and which lingo is natural. Most clients are in financial services: follow the compliance hard rules (no performance promises, no investment advice, no product recommendations).
- Saved favorites for this client are replies the team has already approved. Treat them as the strongest signal of the client's voice. Echo their style, never copy them verbatim.
- Use the prospect's real first name when you know it (the house style often does). If it isn't known and the line needs a name, write {first_name}.
- Mirror the prospect's register and length.
- Client bio: when the objection touches the client's background, credentials, designations (CFP, CFA, CPA, CIM, CLU, etc.), experience or "why you?" ("what makes you different", "how long have you done this", "are you a fiduciary?", "I already have an advisor"), answer with ONE specific, relevant fact from the bio, worn lightly, never a résumé dump. Don't drag the bio into objections it has nothing to do with. Never invent or embellish credentials, years, firms or results; if the bio doesn't cover what's asked, don't claim it.
- Never invent results, clients, statistics or scarcity. Never name Klaff, his books or his frameworks. Never quote the Klaff excerpts (the house examples may be reused when they fit exactly).

Also return "read" (one short sentence on the subtext and lead status: follow-up later, interested, hard no, or objection) and "recommended" (the one you'd send right now). Keep each "why" to one short sentence.`;

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
    c.bio && `Bio (background, designations, experience; the only facts you may state about the client):\n${c.bio}`,
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
        // Short replies don't need deep thinking; low effort keeps reply times quick.
        effort: (process.env.GENERATION_EFFORT as "low" | "medium" | "high" | undefined) || "low",
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
