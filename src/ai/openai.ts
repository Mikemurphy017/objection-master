import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ParsedResponse } from "openai/resources/responses/responses";
import { GenerationError } from "./errors.ts";
import { cleanKey } from "./keys.ts";
import { EXTRACT_SYSTEM, ExtractionSchema, extractPrompt, isSupportedImage, type Extraction } from "./extract.ts";
import { GenerationSchema, buildSystem, buildUserPrompt, type GenerateInput, type Generation } from "./generate.ts";

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

type Effort = "minimal" | "low" | "medium" | "high";
/** Only sent when set: non-reasoning models (e.g. gpt-4o) reject the reasoning parameter. */
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT as Effort | undefined;

let client: OpenAI | null = null;
function getOpenAI(): OpenAI {
  client ??= new OpenAI({ apiKey: cleanKey(process.env.OPENAI_API_KEY) });
  return client;
}

function describeOpenAIError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  if (err instanceof OpenAI.AuthenticationError) {
    return new GenerationError("The OpenAI API key is missing or invalid. Set OPENAI_API_KEY on the server.", 500);
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new GenerationError("OpenAI is rate limited (or out of credit) right now. Try again in a minute.", 429);
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new GenerationError(`OpenAI rejected the request: ${err.message}`, 400);
  }
  if (err instanceof OpenAI.APIError) {
    return new GenerationError(`OpenAI API error (${err.status ?? "network"}): ${err.message}`, 502);
  }
  return new GenerationError(err instanceof Error ? err.message : String(err), 500);
}

/** Pull the parsed object out of a Responses API result, or explain why there isn't one. */
function parsedOrThrow<T>(response: ParsedResponse<T>, what: string): T {
  const refused = response.output.some(
    (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
  );
  if (refused) throw new GenerationError(`OpenAI declined to ${what}. Try rewording or a tighter crop.`);
  if (response.status === "incomplete") {
    throw new GenerationError("The response came back incomplete. Try again.");
  }
  if (!response.output_parsed) throw new GenerationError(`OpenAI couldn't ${what}. Try again.`);
  return response.output_parsed;
}

export async function extractWithOpenAI(
  image: { data: Buffer; mimeType: string },
  knownClientNames: string[],
): Promise<Extraction> {
  if (!isSupportedImage(image.mimeType)) {
    throw new GenerationError(`Unsupported image type ${image.mimeType}. Use PNG, JPEG, GIF or WebP.`, 400);
  }
  try {
    const response = await getOpenAI().responses.parse({
      model: OPENAI_MODEL,
      instructions: EXTRACT_SYSTEM,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              detail: "high",
              image_url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
            },
            { type: "input_text", text: extractPrompt(knownClientNames) },
          ],
        },
      ],
      text: { format: zodTextFormat(ExtractionSchema, "screenshot_extraction") },
      ...(REASONING_EFFORT && { reasoning: { effort: "low" as Effort } }),
    });
    return parsedOrThrow(response, "read this screenshot");
  } catch (err) {
    throw describeOpenAIError(err);
  }
}

export async function generateWithOpenAI(input: GenerateInput): Promise<Generation> {
  try {
    const response = await getOpenAI().responses.parse({
      model: OPENAI_MODEL,
      // Identical on every request, so OpenAI's automatic prefix caching applies.
      instructions: buildSystem(input.coreStyle),
      input: buildUserPrompt(input),
      text: { format: zodTextFormat(GenerationSchema, "objection_replies") },
      ...(REASONING_EFFORT && { reasoning: { effort: REASONING_EFFORT } }),
    });
    return parsedOrThrow(response, "answer this one");
  } catch (err) {
    throw describeOpenAIError(err);
  }
}
