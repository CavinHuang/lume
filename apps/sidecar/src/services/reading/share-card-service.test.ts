import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getReadingShareCardsDir } from "../infra/config-paths";
import { addReadingBook, createReadingNote, listReadingNotes, setReadingBookLocalCover } from "./reading-store";
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

  test("uses the book title initial as the cover fallback like the Lume shelf", () => {
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
    const outputPath = join(tempConfigDir, "fallback-cover.svg");

    generateReadingShareCard({ noteId: note.id, outputPath });

    const svg = readFileSync(outputPath, "utf-8");
    expect(svg).toContain(">人</text>");
    expect(svg).not.toContain(">Lume</text>");
  });

  test("uses the shelf local cover as a file URL for the share card image", () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人。"
      }
    });
    const coverPath = join(tempConfigDir, "covers", "book cover.svg");
    setReadingBookLocalCover(book.id, coverPath);
    const note = createReadingNote({
      bookId: book.id,
      title: "普通人的日常",
      body: "普通人的生活有自己的重量。",
      tags: ["具体生活"],
      evidence: [
        {
          quote: "把自己看作一个普通人。",
          sourceKind: "manual",
          excerpt: "把自己看作一个普通人。",
          capturedAt: 1
        }
      ]
    });
    const outputPath = join(tempConfigDir, "local-cover.svg");

    generateReadingShareCard({ noteId: note.id, outputPath });

    expect(readFileSync(outputPath, "utf-8")).toContain(`href="${pathToFileURL(coverPath).toString()}"`);
  });

  test("keeps long reading note content inside a clipped compact text area", () => {
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
      body: [
        "Lume 今天读《人间词话》时，先停在这句话旁边：词以境界为最上。",
        "它不像一个结论，更像一个入口：把人的处境、身体和选择放回具体生活里看。",
        "这条札记先记下这个位置，等下一次继续读时，再把它和更大的结构连起来。"
      ].join("\n"),
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
    const outputPath = join(tempConfigDir, "long-note.svg");

    generateReadingShareCard({ noteId: note.id, outputPath });

    const svg = readFileSync(outputPath, "utf-8");
    expect(svg).toContain('clip-path="url(#reading-share-card-content-clip)"');
    expect(svg).toContain('font-size="22"');
    expect(svg).not.toContain('font-size="27"');
  });
});
