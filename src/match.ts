import type { Client } from "./db.ts";

/** Professional designations and noise that show up after names on LinkedIn. */
const SUFFIXES = new Set([
  "cfp", "chfc", "clu", "cfa", "cpa", "cima", "cpwa", "ricp", "aif", "crpc", "aams", "cep", "mba", "jd",
  "phd", "esq", "jr", "sr", "ii", "iii", "iv", "he", "him", "she", "her", "they", "them",
]);

/** Common nickname -> formal first name, so "Mike Murphy" resolves to "Michael Murphy". */
const NICKNAMES: Record<string, string> = {
  mike: "michael", mick: "michael", bob: "robert", rob: "robert", bobby: "robert", bill: "william",
  will: "william", liz: "elizabeth", beth: "elizabeth", jim: "james", jimmy: "james", dick: "richard",
  rick: "richard", tom: "thomas", tony: "anthony", dave: "david", dan: "daniel", danny: "daniel",
  chris: "christopher", matt: "matthew", steve: "steven", joe: "joseph", jen: "jennifer", kate: "katherine",
  katie: "katherine", ted: "edward", ed: "edward", ben: "benjamin", sam: "samuel", alex: "alexander",
  nick: "nicholas", greg: "gregory", jeff: "jeffrey", jon: "jonathan", pat: "patrick", peggy: "margaret",
  maggie: "margaret", sue: "susan", andy: "andrew", drew: "andrew", charlie: "charles", chuck: "charles",
  larry: "lawrence", jerry: "gerald", ron: "ronald", don: "donald", ken: "kenneth", tim: "timothy",
};

export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[®™©]/g, "")
    .split(/[|•·(]/)[0] // drop "| Wealth Advisor at X" style headline tails
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ");
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Similarity in [0, 1] between two already-normalized names. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(" ");
  const tb = b.split(" ");
  // "Mike Murphy" vs "Michael J. Murphy": same last name and a compatible first name.
  const firstA = ta[0];
  const firstB = tb[0];
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  const firstCompatible =
    firstA === firstB ||
    (Math.min(firstA.length, firstB.length) >= 3 && (firstA.startsWith(firstB) || firstB.startsWith(firstA))) ||
    // A bare initial ("j smith") only matches the same initial.
    ((firstA.length === 1 || firstB.length === 1) && firstA[0] === firstB[0]) ||
    NICKNAMES[firstA] === firstB ||
    NICKNAMES[firstB] === firstA;
  if (ta.length > 1 && tb.length > 1 && lastA === lastB) {
    if (firstCompatible) return firstA === firstB ? 0.95 : 0.85;
    // Same surname, different person ("Jake Smith" vs "Jane Smith"): never auto-match.
    return 0.5;
  }
  const setA = new Set(ta);
  const overlap = tb.filter((t) => setA.has(t)).length;
  const jaccard = overlap / new Set([...ta, ...tb]).size;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(jaccard, edit);
}

export interface MatchResult {
  client: Client | null;
  score: number;
  candidates: { id: number; name: string; score: number }[];
}

export const MATCH_THRESHOLD = 0.8;

/** Resolve a name read off a screenshot to a stored client (name, aliases, or company). */
export function matchClient(rawNames: (string | null | undefined)[], clients: Client[]): MatchResult {
  const names = rawNames.filter((n): n is string => Boolean(n && n.trim())).map(normalizeName);
  const scored = clients
    .map((client) => {
      const keys = [client.name, ...client.aliases, client.company].filter(Boolean).map(normalizeName);
      let score = 0;
      for (const n of names) for (const k of keys) score = Math.max(score, nameSimilarity(n, k));
      return { client, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  // Ambiguous when two clients score about the same: let a human pick.
  const ambiguous = scored.length > 1 && best && scored[1].score >= best.score - 0.02 && best.score < 1;
  return {
    client: best && best.score >= MATCH_THRESHOLD && !ambiguous ? best.client : null,
    score: best?.score ?? 0,
    candidates: scored.slice(0, 5).map((s) => ({ id: s.client.id, name: s.client.name, score: Number(s.score.toFixed(2)) })),
  };
}
