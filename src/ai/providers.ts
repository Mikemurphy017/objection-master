import { extractFromScreenshot } from "./extract.ts";
import { generateResponses } from "./generate.ts";
import { extractWithOpenAI, generateWithOpenAI, OPENAI_MODEL } from "./openai.ts";
import { MODEL as CLAUDE_MODEL } from "./claude.ts";
import type { AiBackend } from "../app.ts";

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

export function selectBackend(env: NodeJS.ProcessEnv = process.env): AiBackend & { summary: string } {
  const p = resolveProviders(env);
  const label = (x: Provider) => (x === "openai" ? `OpenAI ${OPENAI_MODEL}` : `Claude ${CLAUDE_MODEL}`);
  return {
    extract: p.extraction === "openai" ? extractWithOpenAI : extractFromScreenshot,
    generate: p.generation === "openai" ? generateWithOpenAI : generateResponses,
    summary: `replies: ${label(p.generation)} · screenshots: ${label(p.extraction)}`,
  };
}
