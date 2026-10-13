import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FALLBACK_PARAMS, GenerationError, MODEL, describeApiError, getClient } from "./claude.ts";

export const ExtractionSchema = z.object({
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

export const EXTRACT_SYSTEM = `You read screenshots of sales conversations (usually LinkedIn messaging, sometimes email) for an outbound agency that runs outreach on behalf of its clients.

You're told which client's account the screenshot comes from. That client sent the outreach; the other person in the conversation is the prospect, who replied with an objection, brush-off, question or pushback. On LinkedIn the client's own messages usually sit on the sending side, and the conversation header shows the prospect's name.

Transcribe the conversation exactly. Don't guess anything that isn't in the image.`;

/** The user-turn text that accompanies the screenshot (shared by every provider). */
export function extractPrompt(clientName: string): string {
  return `This screenshot is from our client ${clientName}'s account: ${clientName} sent the outreach and the other person is the prospect.\n\nExtract the conversation details from this screenshot.`;
}

export async function extractFromScreenshot(
  image: { data: Buffer; mimeType: string },
  /** The client whose chat the screenshot was dropped into. */
  clientName: string,
): Promise<Extraction> {
  if (!isSupportedImage(image.mimeType)) {
    throw new GenerationError(`Unsupported image type ${image.mimeType}. Use PNG, JPEG, GIF or WebP.`, 400);
  }
  const known = extractPrompt(clientName);

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
