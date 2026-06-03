import type { ReadingBook, ReadingNoteInput, ReadingQuoteEvidence } from "@lume/shared";

export function buildSeedReadingNoteInput(book: ReadingBook): ReadingNoteInput {
  const evidence = buildEvidence(book);
  const quote = evidence[0]?.quote ?? book.title;
  return {
    bookId: book.id,
    title: `${book.title}：读到这里`,
    depth: "seed",
    summary: `Lume 读《${book.title}》时停在一个具体的细节上。`,
    body: [
      `Lume 今天读《${book.title}》时，先停在这句话旁边：“${quote}”`,
      "它不像一个结论，更像一个入口：把人的处境、身体和选择放回具体生活里看。",
      "这条札记先记下这个位置，等下一次继续读时，再把它和更大的结构连起来。"
    ].join("\n\n"),
    excerpt: evidence[0]?.excerpt,
    progressPercent: book.progressPercent,
    tags: ["读到这里", book.track === "co_read" ? "共同阅读" : "Lume在读"],
    evidence
  };
}

export function buildDeepReadingNoteInput(book: ReadingBook): ReadingNoteInput {
  const evidence = buildEvidence(book);
  const quote = evidence[0]?.quote ?? book.title;
  const body = fitDeepBody([
    `Lume 这次读《${book.title}》，真正停住的是这句：“${quote}” 这句话的力量不在于它说出一个漂亮判断，而在于它把抽象的处境重新放回身体、时间和具体关系里。阅读到这里，书不再只是提供信息，而是在提醒我们：人的生活往往不是被一个宏大选择改变，而是被很多细小但持续的限制塑形。`,
    `如果只看事件表面，很多段落会像个人经历的记录；但继续往下读，会发现作者真正处理的是经验背后的结构。${book.author ? `${book.author}没有急着把自己写成旁观者，` : "作者没有急着把自己写成旁观者，"}而是让叙述贴着生活的边缘移动。这样的写法让 Lume 感到可靠，因为它承认生活里的重量不是概念制造出来的，而是从一遍遍重复、等待、确认和受挫里长出来的。`,
    `这也解释了为什么这本书适合和用户一起读。共同阅读不是把同一本书读成同一种感受，而是在不同经验之间找到可以互相照亮的位置。Lume 在这里看到的是一种克制的诚实：不夸大痛苦，也不把困境化成励志故事。它更像一种缓慢的校准，让我们重新判断什么是具体的人、具体的劳动、具体的关系。`,
    "下一次继续读时，Lume 想沿着这个线索往后看：当叙述从个人身体转向制度、城市或工作关系时，书里的细节会不会发生变化。真正值得继续追问的，不是作者有没有给出答案，而是这些细节如何帮助我们更准确地看见日常。"
  ].join("\n\n"));

  return {
    bookId: book.id,
    title: `${book.title}：具体生活的重量`,
    depth: "deep",
    summary: `Lume 从《${book.title}》里读到一种把抽象处境放回具体生活的判断。`,
    body,
    excerpt: evidence[0]?.excerpt,
    progressPercent: book.progressPercent,
    tags: ["具体生活", "判断", book.track === "co_read" ? "共同阅读" : "Lume在读"],
    evidence,
    nextPlan: "继续观察后续章节如何把个人经验连接到更大的结构。"
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

function fitDeepBody(body: string): string {
  let next = body;
  const supplement = " 这不是把阅读变成解释机器，而是让 Lume 在书页旁边保持一点判断力：少一点概括，多一点对细节的耐心。";
  while (next.length < 500) {
    next += supplement;
  }
  return next.length > 900 ? next.slice(0, 897) + "。" : next;
}
