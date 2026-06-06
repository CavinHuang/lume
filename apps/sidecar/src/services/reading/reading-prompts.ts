import type { ReadingBook, ReadingNoteInput, ReadingQuoteEvidence } from "@lume/shared";

export function buildSeedReadingNoteInput(book: ReadingBook): ReadingNoteInput {
  const evidence = buildEvidence(book);
  const quote = evidence[0]?.quote ?? book.title;
  return {
    bookId: book.id,
    title: `${book.title}：读到这里`,
    depth: "seed",
    summary: `Lume 在读《${book.title}》时记下了这句话。`,
    body: `Lume 在读《${book.title}》时，先停在"${quote}"这句话旁边。等读完更多内容，再回来展开。`,
    excerpt: evidence[0]?.excerpt,
    progressPercent: book.progressPercent,
    tags: ["读到这里", book.track === "co_read" ? "共同阅读" : "Lume在读"],
    evidence
  };
}

export function buildDeepReadingNoteInput(book: ReadingBook): ReadingNoteInput {
  const evidence = buildEvidence(book);
  const quote = evidence[0]?.quote ?? book.title;
  return {
    bookId: book.id,
    title: `${book.title}：读到这里`,
    depth: "deep",
    summary: `Lume 在读《${book.title}》时记下了这句话。`,
    body: `Lume 在读《${book.title}》时，先停在"${quote}"这句话旁边。等读完更多内容，再回来展开。`,
    excerpt: evidence[0]?.excerpt,
    progressPercent: book.progressPercent,
    tags: ["读到这里", book.track === "co_read" ? "共同阅读" : "Lume在读"],
    evidence,
    nextPlan: `继续读《${book.title}》，寻找下一处值得展开的地方。`
  };
}

function buildEvidence(book: ReadingBook): ReadingQuoteEvidence[] {
  const excerpt = book.source.excerpt?.trim() || book.source.title?.trim() || book.title;
  const quote = chooseQuote(excerpt);
  return [
    {
      quote,
      sourceKind: book.source.kind,
      sourceId: book.source.externalId,
      sourceTitle: book.source.title ?? book.title,
      location: book.source.location ?? formatProgress(book.progressPercent),
      excerpt,
      url: book.source.url,
      capturedAt: Date.now()
    }
  ];
}

function chooseQuote(excerpt: string): string {
  const trimmed = excerpt.trim();
  const sentence = trimmed.split(/[。！？.!?]/).find((part) => part.trim());
  if (sentence && sentence.length < trimmed.length) {
    return `${sentence.trim()}${trimmed.includes(`${sentence}。`) ? "。" : ""}`;
  }
  return trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed;
}

function formatProgress(progressPercent?: number): string | undefined {
  return typeof progressPercent === "number" ? `${Math.round(progressPercent)}%` : undefined;
}
