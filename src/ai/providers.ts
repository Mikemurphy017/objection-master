import { extractFromScreenshot } from "./extract.ts";
import { generateResponses } from "./generate.ts";
import { extractWithOpenAI, generateWithOpenAI, OPENAI_MODEL } from "./openai.ts";
import { MODEL as CLAUDE_MODEL } from "./claude.ts";
import type { AiBackend } from "../app.ts";
import { GenerationError } from "./errors.ts";

export type Provider = "openai" | "anthropic";

function pick(explicit: string | undefined, fallback: Provider): Provider {
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  if (explicit) throw new Error(`Unknown provider "${explicit}". Use "openai" or "anthropic".`);
  return fallback;
}

/**
 * Which LLM handles each step. GENERATION_PROVIDER / EXTRACTION_PROVIDER override;
 * otherwise generation uses OpenAI whenever OPENAI_API_KEY is set, and screenshot
 * reading uses whichever key is available (Claude first).
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env) {
  const hasOpenAI = Boolean(env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  return {
    generation: pick(env.GENERATION_PROVIDER, hasOpenAI ? "openai" : "anthropic"),
    extraction: pick(env.EXTRACTION_PROVIDER, hasAnthropic || !hasOpenAI ? "anthropic" : "openai"),
  };
}

/**
 * Try `primary`; if it fails for a reason the other provider wouldn't share
 * (out of credit, rate limit, bad key, outage), retry once with `secondary`.
 * Request problems (400s, e.g. an unreadable image) are not retried.
 */
export function withFallback<A extends unknown[], R>(
  primary: (...args: A) => Promise<R>,
  secondary: ((...args: A) => Promise<R>) | null,
  names: [string, string],
): (...args: A) => Promise<R> {
  if (!secondary) return primary;
  return async (...args: A) => {
    try {
      return await primary(...args);
    } catch (err) {
      if (!(err instanceof GenerationError) || err.status === 400) throw err;
      console.warn(`[ai] ${names[0]} failed (${err.message}); retrying with ${names[1]}.`);
      try {
        return await secondary(...args);
      } catch (err2) {
        throw new GenerationError(`${err.message} Switching to ${names[1]} also failed: ${(err2 as Error).message}`, err.status);
      }
    }
  };
}

export function selectBackend(env: NodeJS.ProcessEnv = process.env): AiBackend & { summary: string } {
  const p = resolveProviders(env);
  const hasOpenAI = Boolean(env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const label = (x: Provider) => (x === "openai" ? `OpenAI ${OPENAI_MODEL}` : `Claude ${CLAUDE_MODEL}`);
  const both = hasOpenAI && hasAnthropic;
  const other = (x: Provider): Provider => (x === "openai" ? "anthropic" : "openai");

  const extractors = { openai: extractWithOpenAI, anthropic: extractFromScreenshot };
  const generators = { openai: generateWithOpenAI, anthropic: generateResponses };
  return {
    extract: withFallback(extractors[p.extraction], both ? extractors[other(p.extraction)] : null, [
      label(p.extraction),
      label(other(p.extraction)),
    ]),
    generate: withFallback(generators[p.generation], both ? generators[other(p.generation)] : null, [
      label(p.generation),
      label(other(p.generation)),
    ]),
    summary:
      `replies: ${label(p.generation)} · screenshots: ${label(p.extraction)}` +
      (both ? " · each falls back to the other provider if it fails" : ""),
  };
}
