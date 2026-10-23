import type { ImageStore } from "./images.ts";
import { getOpenAI, OPENAI_MODEL } from "./ai/openai.ts";
import { getClient as getClaude, MODEL as CLAUDE_MODEL } from "./ai/claude.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const short = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);

async function run(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: short(err) };
  }
}

/** Write, read back and delete a tiny probe, so bad bucket keys show up at deploy time, not on the first screenshot. */
export function checkImages(images: ImageStore): Promise<Check> {
  return run("Screenshot storage", async () => {
    const id = `selfcheck-${Date.now()}.png`;
    await images.save(id, Buffer.from("ok"), "image/png");
    const found = await images.get(id);
    if (!found) throw new Error("probe was written but could not be read back");
    found.body.resume();
    await images.remove(id);
    return "write, read and delete OK";
  });
}

/**
 * Startup health check: storage plus each AI key (a free model lookup, no tokens spent).
 * Logs one line per check; never throws, never blocks startup.
 */
export async function selfCheck(images: ImageStore, providers: { openai: boolean; anthropic: boolean }): Promise<Check[]> {
  const checks = await Promise.all([
    checkImages(images),
    providers.openai
      ? run("OpenAI key", async () => (await getOpenAI().models.retrieve(OPENAI_MODEL), `${OPENAI_MODEL} available`))
      : null,
    providers.anthropic
      ? run("Claude key", async () => (await getClaude().models.retrieve(CLAUDE_MODEL), `${CLAUDE_MODEL} available`))
      : null,
  ]);
  const done = checks.filter((c): c is Check => c !== null);
  for (const c of done) {
    (c.ok ? console.log : console.error)(`Self-check: ${c.name} ${c.ok ? "OK" : "FAILED"} (${c.detail})`);
  }
  return done;
}
