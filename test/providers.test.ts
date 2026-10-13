import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviders } from "../src/ai/providers.ts";

test("OpenAI key alone: OpenAI handles replies and screenshots", () => {
  assert.deepEqual(resolveProviders({ OPENAI_API_KEY: "x" }), { generation: "openai", extraction: "openai" });
});

test("both keys: OpenAI writes replies, Claude reads screenshots", () => {
  assert.deepEqual(resolveProviders({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" }), {
    generation: "openai",
    extraction: "anthropic",
  });
});

test("Anthropic key alone keeps everything on Claude", () => {
  assert.deepEqual(resolveProviders({ ANTHROPIC_API_KEY: "y" }), { generation: "anthropic", extraction: "anthropic" });
});

test("explicit overrides win, and typos fail loudly", () => {
  assert.deepEqual(
    resolveProviders({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y", GENERATION_PROVIDER: "anthropic", EXTRACTION_PROVIDER: "openai" }),
    { generation: "anthropic", extraction: "openai" },
  );
  assert.throws(() => resolveProviders({ GENERATION_PROVIDER: "gpt" }), /Unknown provider/);
});
