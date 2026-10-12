import type { CorpusChunk } from "../db.ts";

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing for from had has have having he her " +
    "here him his how i if in into is it its just me more most my no not now of off on once only or other " +
    "our out over own same she should so some such than that the their them then there these they this " +
    "those through to too under until up very was we were what when where which while who whom why will " +
    "with would you your yours um uh like gonna right yeah okay ok kind sort really know thing things get got"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9$]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** Okapi BM25 over corpus chunks. Small enough to rebuild in memory on every corpus change. */
export class Bm25Index {
  private docs: { chunk: CorpusChunk; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private readonly k1 = 1.4;
  private readonly b = 0.75;

  constructor(chunks: CorpusChunk[]) {
    for (const chunk of chunks) {
      const tokens = tokenize(`${chunk.heading} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: tokens.length });
    }
    this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / (this.docs.length || 1);
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * Top-k chunks for the query, at most `perSection` from any one section so a
   * single long transcript can't crowd out everything else.
   */
  search(query: string, k = 6, perSection = 2): { chunk: CorpusChunk; score: number }[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const scored = this.docs
      .map((d) => {
        let score = 0;
        for (const t of terms) {
          const f = d.tf.get(t);
          if (!f) continue;
          const df = this.df.get(t)!;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
        }
        return { chunk: d.chunk, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const perKey = new Map<string, number>();
    const out: { chunk: CorpusChunk; score: number }[] = [];
    for (const s of scored) {
      const key = `${s.chunk.document_id}:${s.chunk.heading}`;
      const used = perKey.get(key) ?? 0;
      if (used >= perSection) continue;
      perKey.set(key, used + 1);
      out.push(s);
      if (out.length >= k) break;
    }
    return out;
  }
}

/** Generic outreach vocabulary that pulls the passages on replies, follow-up and booking calls. */
const OUTREACH_HINTS =
  "objection reply follow up meeting call schedule calendar status frame neediness intrigue question relevant";

/**
 * Excerpts for one objection: mostly passages that match what the prospect
 * actually said, topped up with general follow-up / booking technique.
 */
export function retrieveExcerpts(
  index: Bm25Index,
  objection: string,
  thread = "",
  serviceType = "",
  total = Number(process.env.CORPUS_EXCERPTS) || 6,
) {
  const specific = index.search(`${objection} ${thread} ${serviceType}`, Math.ceil((total * 2) / 3));
  const general = index.search(`${objection} ${OUTREACH_HINTS}`, total);
  const seen = new Set(specific.map((r) => r.chunk.id));
  const merged = [...specific];
  for (const r of general) {
    if (merged.length >= total) break;
    if (!seen.has(r.chunk.id)) merged.push(r);
  }
  return merged.map((r) => r.chunk);
}
