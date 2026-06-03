import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingCoversDir } from "../infra/config-paths";
import { addReadingBook, listReadingBooks } from "./reading-store";
import { generateReadingCover } from "./cover-generator";

describe("cover-generator", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-cover-"));
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

  test("generates a local Alice-like SVG cover and attaches it to the book", () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1"
      },
      tags: ["共同阅读", "普通生活"]
    });

    const result = generateReadingCover({ bookId: book.id });

    expect(result.path.startsWith(getReadingCoversDir())).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();
    const svg = readFileSync(result.path, "utf-8");
    expect(svg).toContain("我在北京送快递");
    expect(svg).toContain("胡安焉");
    expect(svg).toContain("Lume Reading");
    expect(listReadingBooks()[0]).toMatchObject({
      id: book.id,
      localCoverPath: result.path
    });
  });
});
