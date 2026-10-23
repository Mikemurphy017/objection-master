import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ParsedResponse } from "openai/resources/responses/responses";
import { GenerationError } from "./errors.ts";
import { cleanKey } from "./keys.ts";
import { EXTRACT_SYSTEM, ExtractionSchema, extractPrompt, isSupportedImage, type Extraction } from "./extract.ts";
import { GenerationSchema, buildSystem, buildUserPrompt, type GenerateInput, type Generation } from "./generate.ts";

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

type Effort = "none" | "minimal" | "low" | "medium" | "high";

/**
 * Speed settings. Replies are short, so deep reasoning mostly adds wait time.
 * Reasoning models run at "Instant" (ChatGPT's lowest thinking setting) for both
 * replies and screenshots, plus low verbosity. In the API that's effort "none"
 * on gpt-5.1 and later, "minimal" on gpt-5, and "low" (their floor) on o-series.
 * Override with OPENAI_REASONING_EFFORT (none / minimal / low / medium / high, or "instant").
 * Non-reasoning models (e.g. gpt-4o) reject these parameters, so they're omitted there.
 */
const IS_REASONING_MODEL = /^(gpt-5|o\d)/.test(OPENAI_MODEL);
const IS_GPT5 = OPENAI_MODEL.startsWith("gpt-5");
export function instantEffort(model: string): Effort {
  if (/^gpt-5\.\d/.test(model)) return "none";
  if (model.startsWith("gpt-5")) return "minimal";
  return "low";
}
const envEffort = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
const REASONING_EFFORT = (envEffort === "instant" ? instantEffort(OPENAI_MODEL) : envEffort || undefined) as Effort | undefined;
function speedParams() {
  const effort = REASONING_EFFORT ?? (IS_REASONING_MODEL ? instantEffort(OPENAI_MODEL) : undefined);
  return {
    ...(effort && { reasoning: { effort } }),
    ...(IS_GPT5 && { verbosity: "low" as const }),
  };
}

/** The `text` (format + verbosity) and `reasoning` request fields for a call. */
function withSpeed<F>(format: F) {
  const { verbosity, ...rest } = speedParams();
  return { text: { format, ...(verbosity && { verbosity }) }, ...rest };
}

let client: OpenAI | null = null;
export function getOpenAI(): OpenAI {
  client ??= new OpenAI({ apiKey: cleanKey(process.env.OPENAI_API_KEY) });
  return client;
}

function describeOpenAIError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  if (err instanceof OpenAI.AuthenticationError) {
    return new GenerationError("The OpenAI API key is missing or invalid. Set OPENAI_API_KEY on the server.", 500);
  }
  if (err instanceof OpenAI.RateLimitError) {
    // OpenAI uses 429 both for "slow down" and for an account with no credit left.
    if (err.code === "insufficient_quota") {
      return new GenerationError(
        "The OpenAI account is out of credit (insufficient quota). Add billing or credit at platform.openai.com.",
        429,
      );
    }
    return new GenerationError("OpenAI is rate limiting requests right now. Try again in a minute.", 429);
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
  clientName: string,
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
            { type: "input_text", text: extractPrompt(clientName) },
          ],
        },
      ],
      ...withSpeed(zodTextFormat(ExtractionSchema, "screenshot_extraction")),
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
      ...withSpeed(zodTextFormat(GenerationSchema, "objection_replies")),
    });
    return parsedOrThrow(response, "answer this one");
  } catch (err) {
    throw describeOpenAIError(err);
  }
}
