import mammoth from "mammoth";
import path from "node:path";

/** A source document split into titled sections, ready for chunking. */
export interface ParsedDocument {
  title: string;
  sections: { heading: string; text: string }[];
}

/** Video-transcript timestamps such as "0:03", "12:45" or "1:02:33". */
const TIMESTAMP = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;

/**
 * Remove inline transcript timestamps and collapse the whitespace left behind.
 * Only applied when a document is mostly timestamped transcript, so clock times
 * like "2:30 PM" in ordinary prose are left alone.
 */
export function stripTimestamps(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(TIMESTAMP, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ +([,.?!])/g, "$1")
        .trim(),
    )
    .join("\n")
    .trim();
}

function looksLikeTranscript(text: string): boolean {
  const words = text.split(/\s+/).length || 1;
  const stamps = text.match(TIMESTAMP)?.length ?? 0;
  return stamps / words > 0.02;
}

/** Re-flow hard-wrapped lines into paragraphs separated by blank lines. */
function reflow(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Split markdown-ish text on "#"/"##" headings, or on numbered headings of the
 * form "3 Payroll and Benefits Outreach" (what Word exports for a numbered
 * heading list). A table of contents that repeats every heading is dropped.
 */
export function splitSections(raw: string, fallbackTitle: string): ParsedDocument {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let title = fallbackTitle;
  const sections: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } = { heading: "", lines: [] };

  const mdHeading = /^#{1,3}\s+(.+)$/;
  const numberedHeading = /^(\d{1,3})\s+([A-Z][A-Za-z0-9&,'’\- ]{3,90})$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const md = trimmed.match(mdHeading);
    const num = !md ? trimmed.match(numberedHeading) : null;
    if (md && /^#\s/.test(trimmed) && sections.length === 0 && current.lines.length === 0) {
      title = md[1].trim();
      continue;
    }
    if (md || num) {
      const heading = md ? md[1].trim() : `${num![1]} ${num![2].trim()}`;
      sections.push(current);
      current = { heading, lines: [] };
      continue;
    }
    if (/^Source:\s/.test(trimmed)) continue;
    current.lines.push(line);
  }
  sections.push(current);

  const out = sections
    .map((s) => ({ heading: s.heading, text: reflow(s.lines.join("\n")) }))
    // Drop empty table-of-contents entries (heading with no body).
    .filter((s) => s.text.length > 0 || !s.heading)
    .filter((s) => s.text.length > 0);

  // The first unheaded block of a Word export is usually the doc's title line.
  if (title === fallbackTitle && out.length > 1 && !out[0].heading && out[0].text.length < 300) {
    title = out[0].text.replace(/\s+Contents$/, "");
    out.shift();
  }
  for (const s of out) if (s.text === "Contents") s.text = "";

  const transcript = looksLikeTranscript(raw);
  const seenText = new Set<string>();
  return {
    title,
    sections: out
      .filter((s) => s.text)
      .map((s) => ({ heading: s.heading || title, text: transcript ? stripTimestamps(s.text) : s.text }))
      // Exports sometimes paste the same source twice; keep the first copy only.
      .filter((s) => !seenText.has(s.text) && seenText.add(s.text)),
  };
}

/** Turn an uploaded file (docx, md, txt) into a ParsedDocument. */
export async function parseFile(filename: string, data: Buffer): Promise<ParsedDocument> {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).replace(/^[0-9a-f]{8}-/, "").replace(/[_-]+/g, " ");
  let raw: string;
  if (ext === ".docx") {
    raw = (await mammoth.extractRawText({ buffer: data })).value;
  } else if (ext === ".md" || ext === ".txt" || ext === ".markdown") {
    raw = data.toString("utf8");
  } else {
    throw new Error(`Unsupported file type "${ext}". Upload .docx, .md or .txt.`);
  }
  return splitSections(raw, base);
}

/** Render a ParsedDocument back to markdown (used to commit sources into corpus/). */
export function toMarkdown(doc: ParsedDocument): string {
  return [`# ${doc.title}`, ...doc.sections.map((s) => `## ${s.heading}\n\n${s.text}`)].join("\n\n") + "\n";
}
