import type { ReadingQuoteEvidence } from "@lume/shared";

export type ReadingQuoteEvidenceValidation =
  | { ok: true }
  | { ok: false; reason: string };

export function validateReadingQuoteEvidence(evidence: ReadingQuoteEvidence[] = []): ReadingQuoteEvidenceValidation {
  for (const item of evidence) {
    const quote = item.quote.trim();
    if (!quote) {
      return { ok: false, reason: "引用不能为空" };
    }
    if (!item.excerpt || !containsQuote(item.excerpt, quote)) {
      return { ok: false, reason: `引用缺少原文证据: ${quote}` };
    }
  }
  return { ok: true };
}

function containsQuote(excerpt: string, quote: string): boolean {
  return normalizeQuoteText(excerpt).includes(normalizeQuoteText(quote));
}

function normalizeQuoteText(value: string): string {
  return value.replace(/\s+/g, "");
}
