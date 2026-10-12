/**
 * Convert a source file (docx/md/txt) into a cleaned markdown file in corpus/.
 * Usage: npm run corpus:import -- path/to/file.docx [output-name]
 */
import fs from "node:fs";
import path from "node:path";
import { parseFile, toMarkdown } from "../src/corpus/ingest.ts";

const [input, outName] = process.argv.slice(2);
if (!input) {
  console.error("Usage: npm run corpus:import -- <file.docx|md|txt> [output-name]");
  process.exit(1);
}
const doc = await parseFile(path.basename(input), fs.readFileSync(input));
const slug =
  outName ??
  doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const out = path.join("corpus", `${slug}.md`);
fs.writeFileSync(out, toMarkdown(doc));
const words = doc.sections.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
console.log(`Wrote ${out}: ${doc.sections.length} sections, ${words} words`);
