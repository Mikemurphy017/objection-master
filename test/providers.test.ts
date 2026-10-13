import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviders } from "../src/ai/providers.ts";
import { cleanKey } from "../src/ai/keys.ts";

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

test("pasted API keys are cleaned of quotes and whitespace", () => {
  assert.equal(cleanKey('  "sk-ant-abc123"\n'), "sk-ant-abc123");
  assert.equal(cleanKey("'sk-proj-xyz' "), "sk-proj-xyz");
  assert.equal(cleanKey("sk-plain"), "sk-plain");
  assert.equal(cleanKey("   "), undefined);
  assert.equal(cleanKey(undefined), undefined);
});
