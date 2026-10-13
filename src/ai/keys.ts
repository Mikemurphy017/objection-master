/**
 * API keys pasted into a dashboard often pick up stray whitespace, a trailing
 * newline or surrounding quotes, which the providers reject as invalid.
 * Undefined when unset, so the SDKs fall back to their usual credential lookup.
 */
export function cleanKey(value: string | undefined): string | undefined {
  const key = value?.trim().replace(/^["']+|["']+$/g, "").trim();
  return key || undefined;
}
