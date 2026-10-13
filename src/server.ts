import path from "node:path";
import { Store } from "./db.ts";
import { ROOT, createApp, syncRepoCorpus } from "./app.ts";
import { resolveProviders, selectBackend } from "./ai/providers.ts";

const dataDir = process.env.DATA_DIR || path.join(ROOT, "data");
const store = new Store(path.join(dataDir, "objection-master.db"));
await syncRepoCorpus(store);

const providers = resolveProviders();
const needsOpenAI = Object.values(providers).includes("openai");
const needsAnthropic = Object.values(providers).includes("anthropic");
if (needsOpenAI && !process.env.OPENAI_API_KEY) {
  console.warn("Warning: OPENAI_API_KEY is not set. OpenAI calls will fail until it is.");
}
if (needsAnthropic && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Claude calls will fail until it is.");
}
if (!process.env.APP_PASSWORD) {
  console.warn("Warning: APP_PASSWORD is not set, so the app is open to anyone who can reach it.");
}

const backend = selectBackend();
const app = createApp(store, backend, {
  password: process.env.APP_PASSWORD,
  uploadsDir: path.join(dataDir, "uploads"),
});
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  const docs = store.listDocuments();
  console.log(`Objection Master Pro on http://localhost:${port} (${docs.length} corpus documents loaded)`);
  console.log(backend.summary);
});
