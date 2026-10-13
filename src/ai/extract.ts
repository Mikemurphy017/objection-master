import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FALLBACK_PARAMS, GenerationError, MODEL, describeApiError, getClient } from "./claude.ts";

export const ExtractionSchema = z.object({
  client_name: z
    .string()
    .nullable()
    .describe("Name of OUR client: the account owner who sent the outreach (their messages are on the sending side)."),
  client_match: z
    .string()
    .nullable()
    .describe("If client_name corresponds to one of the known client names provided, that exact known name; else null."),
  prospect_name: z.string().nullable().describe("Full name of the prospect who wrote the objection."),
  prospect_headline: z
    .string()
    .nullable()
    .describe("Prospect title, firm or headline if visible in the screenshot."),
  objection_text: z
    .string()
    .describe("The prospect's most recent message(s), transcribed verbatim. This is the objection to answer."),
  thread_context: z
    .string()
    .describe("Earlier messages in the thread, oldest first, each prefixed with the sender's name. Empty if none."),
  channel: z.enum(["linkedin", "email", "other"]),
  notes: z.string().describe("Anything unclear or cut off in the screenshot. Empty if nothing."),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SUPPORTED = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof SUPPORTED)[number];

export function isSupportedImage(mime: string): mime is ImageType {
  return (SUPPORTED as readonly string[]).includes(mime);
}

export const EXTRACT_SYSTEM = `You read screenshots of sales conversations (usually LinkedIn messaging, sometimes email) for an outbound agency.

The agency runs LinkedIn outreach on behalf of its clients. In every screenshot:
- OUR CLIENT is the account owner: the person who sent the outreach. On LinkedIn their messages usually sit under their own name/photo and the conversation header shows the OTHER person's name. In email, they're the original sender.
- THE PROSPECT is the person who replied with an objection, brush-off, question or pushback.

Read the screenshot carefully and transcribe text exactly. If the client's name isn't visible but a known client name appears anywhere (signature, header, "You" replaced by a name), use it. Don't guess names that aren't in the image.`;

/** The user-turn text that accompanies the screenshot (shared by every provider). */
export function extractPrompt(knownClientNames: string[], forClient?: string): string {
  if (forClient) {
    // The user is already in this client's chat, so there's nothing to identify.
    return `This screenshot is from our client ${forClient}'s account: ${forClient} sent the outreach and the other person is the prospect. Set client_name and client_match to "${forClient}".\n\nExtract the conversation details from this screenshot.`;
  }
  const known = knownClientNames.length
    ? `Known clients (use for client_match):\n${knownClientNames.map((n) => `- ${n}`).join("\n")}`
    : "No clients are on file yet, so client_match must be null.";
  return `${known}\n\nExtract the conversation details from this screenshot.`;
}

export async function extractFromScreenshot(
  image: { data: Buffer; mimeType: string },
  knownClientNames: string[],
  forClient?: string,
): Promise<Extraction> {
  if (!isSupportedImage(image.mimeType)) {
    throw new GenerationError(`Unsupported image type ${image.mimeType}. Use PNG, JPEG, GIF or WebP.`, 400);
  }
  const known = extractPrompt(knownClientNames, forClient);

  try {
    const response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      ...FALLBACK_PARAMS,
      output_config: { effort: "low", format: betaZodOutputFormat(ExtractionSchema) },
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") },
            },
            { type: "text", text: known },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      throw new GenerationError("Claude declined to read this screenshot. Try a tighter crop of just the conversation.");
    }
    if (!response.parsed_output) {
      throw new GenerationError("Couldn't read the screenshot. Try a clearer or tighter crop.");
    }
    return response.parsed_output;
  } catch (err) {
    throw describeApiError(err);
  }
}
