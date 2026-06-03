import { describe, expect, test } from "bun:test";
import type { ReadingBook } from "@lume/shared";
import { collectReadingEvidence } from "./reading-evidence";

describe("reading-evidence", () => {
  test("maps Alice-like WeRead best bookmarks into quote evidence", async () => {
    const evidence = await collectReadingEvidence({
      book: buildWereadBook(),
      now: () => 123,
      async loadBestBookmarks() {
        return [
          {
            markText: "把自己看作一个普通人，过普通人的生活。",
            totalCount: 58,
            chapterTitle: "第一章"
          },
          {
            markText: "身体知道自己在做什么。",
            totalCount: 12,
            chapterTitle: "第二章"
          }
        ];
      }
    });

    expect(evidence).toEqual([
      {
        quote: "把自己看作一个普通人，过普通人的生活。",
        sourceKind: "weread",
        sourceId: "wr-1",
        sourceTitle: "我在北京送快递",
        location: "第一章",
        excerpt: "把自己看作一个普通人，过普通人的生活。",
        url: "https://weread.qq.com/web/book/wr-1",
        capturedAt: 123
      },
      {
        quote: "身体知道自己在做什么。",
        sourceKind: "weread",
        sourceId: "wr-1",
        sourceTitle: "我在北京送快递",
        location: "第二章",
        excerpt: "身体知道自己在做什么。",
        url: "https://weread.qq.com/web/book/wr-1",
        capturedAt: 123
      }
    ]);
  });

  test("prefers user's WeRead bookmarks before public best bookmarks", async () => {
    const evidence = await collectReadingEvidence({
      book: buildWereadBook(),
      now: () => 456,
      async loadBookmarks() {
        return [
          {
            markText: "我自己划下了普通生活的重量。",
            chapterName: "用户划线章节"
          }
        ];
      },
      async loadBestBookmarks() {
        return [
          {
            markText: "公开高赞划线作为补充。",
            chapterTitle: "公共划线章节"
          }
        ];
      }
    });

    expect(evidence).toEqual([
      {
        quote: "我自己划下了普通生活的重量。",
        sourceKind: "weread",
        sourceId: "wr-1",
        sourceTitle: "我在北京送快递",
        location: "用户划线章节",
        excerpt: "我自己划下了普通生活的重量。",
        url: "https://weread.qq.com/web/book/wr-1",
        capturedAt: 456
      },
      {
        quote: "公开高赞划线作为补充。",
        sourceKind: "weread",
        sourceId: "wr-1",
        sourceTitle: "我在北京送快递",
        location: "公共划线章节",
        excerpt: "公开高赞划线作为补充。",
        url: "https://weread.qq.com/web/book/wr-1",
        capturedAt: 456
      }
    ]);
  });
});

function buildWereadBook(): ReadingBook {
  return {
    id: "book-1",
    title: "我在北京送快递",
    author: "胡安焉",
    track: "co_read",
    status: "reading",
    source: {
      kind: "weread",
      externalId: "wr-1",
      url: "https://weread.qq.com/web/book/wr-1"
    },
    progressPercent: 54,
    tags: [],
    addedAt: 1,
    updatedAt: 1
  };
}
