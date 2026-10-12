import path from "node:path";
import { Store } from "./db.ts";
import { ROOT, createApp, syncRepoCorpus } from "./app.ts";
import { extractFromScreenshot } from "./ai/extract.ts";
import { generateResponses } from "./ai/generate.ts";

const dataDir = process.env.DATA_DIR || path.join(ROOT, "data");
const store = new Store(path.join(dataDir, "objection-master.db"));
await syncRepoCorpus(store);

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Screenshot reading and generation will fail until it is.");
}
if (!process.env.APP_PASSWORD) {
  console.warn("Warning: APP_PASSWORD is not set, so the app is open to anyone who can reach it.");
}

const app = createApp(
  store,
  { extract: extractFromScreenshot, generate: generateResponses },
  { password: process.env.APP_PASSWORD },
);
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  const docs = store.listDocuments();
  console.log(`Objection Master Pro on http://localhost:${port} (${docs.length} corpus documents loaded)`);
});
