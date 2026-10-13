import Anthropic from "@anthropic-ai/sdk";
import { GenerationError } from "./errors.ts";
import { cleanKey } from "./keys.ts";

export { GenerationError };

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/**
 * Server-side refusal fallback: if a safety classifier declines a request, the
 * API re-runs it on Anthropic's recommended fallback model inside the same call.
 */
export const FALLBACK_PARAMS: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: cleanKey(process.env.ANTHROPIC_API_KEY) });
  return client;
}

/** Turn SDK errors into messages the team can act on. */
export function describeApiError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new GenerationError("The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY on the server.", 500);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new GenerationError("Claude is rate limited right now. Try again in a minute.", 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new GenerationError(`Claude rejected the request: ${err.message}`, 400);
  }
  if (err instanceof Anthropic.APIError) {
    return new GenerationError(`Claude API error (${err.status ?? "network"}): ${err.message}`, 502);
  }
  return new GenerationError(err instanceof Error ? err.message : String(err), 500);
}
