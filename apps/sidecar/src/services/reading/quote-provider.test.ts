import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReadingBook, createReadingNote } from "./reading-store";
import { listReadingQuotes, refreshReadingQuotes } from "./quote-provider";

describe("quote-provider", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-quotes-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("refreshes a reusable quote bank from note evidence and WeRead best bookmarks", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1"
      }
    });
    createReadingNote({
      bookId: book.id,
      body: "Lume 先把这句话留在旁边。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          sourceId: "wr-1",
          sourceTitle: "我在北京送快递",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          location: "54%",
          capturedAt: 1
        }
      ]
    });

    const result = await refreshReadingQuotes({
      bookId: book.id,
      loadBestBookmarks: async () => [
        {
          markText: "送完这栋楼，电动车转个弯，风打在脸上。",
          totalCount: 1200,
          chapterTitle: "通勤",
          bookTitle: "我在北京送快递",
          bookAuthor: "胡安焉"
        }
      ]
    });

    expect(result).toMatchObject({
      ok: true,
      refreshed: 2,
      bookId: book.id
    });
    expect(existsSync(result.path)).toBeTrue();
    expect(listReadingQuotes({ bookId: book.id })).toMatchObject([
      {
        text: "送完这栋楼，电动车转个弯，风打在脸上。",
        origin: "weread",
        highlightCount: 1200,
        source: "《我在北京送快递》·通勤"
      },
      {
        text: "把自己看作一个普通人，过普通人的生活。",
        origin: "reading_note",
        source: "《我在北京送快递》"
      }
    ]);
  });
});
