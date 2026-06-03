import { describe, expect, test } from "bun:test";
import type { ReadingNote } from "@lume/shared";
import { parseReadingNoteMarkdown, serializeReadingNoteMarkdown } from "./note-markdown";

describe("reading note markdown", () => {
  test("round-trips Reading note metadata and body", () => {
    const note: ReadingNote = {
      id: "note-1",
      bookId: "book-1",
      title: "普通人的日常",
      depth: "deep",
      summary: "胡安焉把普通劳动写成可触摸的生活。",
      body: "这是一段读书札记正文。\n\n它保留段落结构。",
      excerpt: "把自己看作一个普通人，过普通人的生活。",
      progressPercent: 54,
      tags: ["身体在场", "劳动边界"],
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          sourceId: "wr-1",
          sourceTitle: "我在北京送快递",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          location: "54%",
          capturedAt: 100
        }
      ],
      aiGenerated: true,
      hidden: false,
      deleted: false,
      createdAt: 100,
      updatedAt: 120,
      nextPlan: "继续看他如何处理身体和制度之间的距离。"
    };

    const markdown = serializeReadingNoteMarkdown(note);
    expect(markdown).toContain("---");
    expect(markdown).toContain("这是一段读书札记正文。");

    expect(parseReadingNoteMarkdown(markdown)).toEqual(note);
  });
});
