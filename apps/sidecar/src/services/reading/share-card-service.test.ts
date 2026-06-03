import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingShareCardsDir } from "../infra/config-paths";
import { addReadingBook, createReadingNote, listReadingNotes } from "./reading-store";
import { generateReadingShareCard } from "./share-card-service";

describe("share-card-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-share-"));
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

  test("generates an SVG share card under Reading assets", () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      }
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "普通人的日常",
      summary: "Lume 从具体劳动里读到普通生活的重量。",
      body: "胡安焉写下的是一种具体生活的重量。",
      tags: ["具体生活"],
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });

    const result = generateReadingShareCard({ noteId: note.id });
    expect(result.path.startsWith(getReadingShareCardsDir())).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();

    const svg = readFileSync(result.path, "utf-8");
    expect(svg).toContain("sourceNoteId");
    expect(svg).toContain(note.id);
    expect(svg).toContain("我在北京送快递");
    expect(svg).toContain("Lume Reading");
    expect(listReadingNotes({ includeHidden: true })[0]?.shareCardPath).toBe(result.path);
  });
});
