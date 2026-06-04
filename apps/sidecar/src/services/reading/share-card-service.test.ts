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

  test("generates an SVG share card at a user-selected output path", () => {
    const book = addReadingBook({
      title: "人间词话",
      author: "王国维",
      source: {
        kind: "manual",
        excerpt: "词以境界为最上。"
      }
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "境界",
      summary: "Lume 记下这句话。",
      body: "词以境界为最上。",
      tags: ["境界"],
      evidence: [
        {
          quote: "词以境界为最上。",
          sourceKind: "manual",
          excerpt: "词以境界为最上。",
          capturedAt: 1
        }
      ]
    });
    const outputPath = join(tempConfigDir, "selected-card.svg");

    const result = generateReadingShareCard({ noteId: note.id, outputPath });

    expect(result.path).toBe(outputPath);
    expect(existsSync(outputPath)).toBeTrue();
    expect(readFileSync(outputPath, "utf-8")).toContain("人间词话");
    expect(listReadingNotes({ includeHidden: true })[0]?.shareCardPath).toBe(outputPath);
  });

  test("uses the selected reading note body as the share card content", () => {
    const book = addReadingBook({
      title: "好吗好的",
      author: "大冰",
      source: {
        kind: "weread",
        excerpt: "没资格谈论理想时，先好好去挣钱。"
      }
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "最后一个义工",
      summary: "这是一段摘要，不是当前卡片正文。",
      body: "没资格谈论理想时，先好好去挣钱。\n\n杯酒慰风尘，如是许多年。",
      tags: ["微信读书"],
      evidence: [
        {
          quote: "没资格谈论理想时，先好好去挣钱。",
          sourceKind: "weread",
          excerpt: "没资格谈论理想时，先好好去挣钱。",
          capturedAt: 1
        }
      ]
    });
    const outputPath = join(tempConfigDir, "selected-note-body.svg");

    generateReadingShareCard({ noteId: note.id, outputPath });

    const svg = readFileSync(outputPath, "utf-8");
    expect(svg).toContain("没资格谈论理想时，先好好去挣钱。");
    expect(svg).not.toContain("这是一段摘要，不是当前卡片正文。");
  });
});
