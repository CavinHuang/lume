import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getReadingAssetsDir,
  getReadingCoversDir,
  getReadingDir,
  getReadingLibraryPath,
  getReadingNotesDir,
  getReadingRunsDir,
  getReadingSettingsPath,
  getReadingShareCardsDir
} from "../infra/config-paths";
import {
  addReadingBook,
  createReadingNote,
  getReadingSnapshot,
  getReadingNote,
  hideReadingNote,
  initReadingStorage,
  listReadingBooks,
  listReadingNotes,
  reviseReadingNote,
  syncReadingWereadShelf
} from "./reading-store";

describe("reading-store", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-store-"));
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

  test("initializes the Reading storage layout", () => {
    initReadingStorage();

    expect(existsSync(getReadingDir())).toBeTrue();
    expect(existsSync(getReadingLibraryPath())).toBeTrue();
    expect(existsSync(getReadingSettingsPath())).toBeTrue();
    expect(existsSync(getReadingNotesDir())).toBeTrue();
    expect(existsSync(getReadingAssetsDir())).toBeTrue();
    expect(existsSync(getReadingCoversDir())).toBeTrue();
    expect(existsSync(getReadingShareCardsDir())).toBeTrue();
    expect(existsSync(getReadingRunsDir())).toBeTrue();
  });

  test("bootstraps one Lume self-reading book on the first snapshot", () => {
    const first = getReadingSnapshot();

    expect(first.books).toHaveLength(1);
    expect(first.books[0]).toMatchObject({
      title: "人间词话",
      author: "王国维",
      track: "lume",
      status: "reading",
      source: {
        kind: "manual",
        title: "人间词话",
        excerpt: "词以境界为最上。有境界则自成高格，自有名句。"
      },
      progressPercent: 1,
      tags: ["Lume 自读", "公共领域"]
    });
    expect(first.stats).toMatchObject({
      readingCount: 1,
      noteCount: 0
    });

    expect(getReadingSnapshot().books).toHaveLength(1);
  });

  test("reads a UTF-8 BOM-prefixed library without hiding its books", () => {
    const book = addReadingBook({
      title: "文心雕龙",
      author: "刘勰",
      progressPercent: 38
    });
    const libraryPath = getReadingLibraryPath();
    writeFileSync(libraryPath, `\uFEFF${readFileSync(libraryPath, "utf-8")}`, "utf-8");

    expect(getReadingSnapshot()).toMatchObject({
      books: [{
        id: book.id,
        title: "文心雕龙",
        status: "reading",
        progressPercent: 38
      }],
      stats: {
        readingCount: 1
      }
    });
  });

  test("stores books and filters hidden notes from normal results", () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      source: {
        kind: "weread",
        externalId: "wr-1",
        title: "我在北京送快递"
      },
      progressPercent: 54
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "身体在场",
      depth: "deep",
      summary: "普通生活被写得具体而有重量。",
      body: "胡安焉把劳动写在身体的位置里。",
      excerpt: "把自己看作一个普通人，过普通人的生活。",
      progressPercent: 54,
      tags: ["身体在场"],
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          sourceId: "wr-1",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });

    expect(getReadingSnapshot().stats).toMatchObject({
      readingCount: 1,
      noteCount: 1,
      finishedCount: 0
    });
    expect(listReadingNotes()).toHaveLength(1);

    hideReadingNote(note.id);
    expect(listReadingNotes()).toEqual([]);
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      id: note.id,
      hidden: true
    });
  });

  test("syncs WeRead readingProgress into stored reading progress", () => {
    const books = syncReadingWereadShelf([
      {
        bookInfo: {
          bookId: "wr-ok",
          title: "好吗好的",
          author: "大冰"
        },
        readingProgress: 59,
        lastReadTime: 1717200000
      }
    ]);

    expect(books.find((book) => book.source.externalId === "wr-ok")).toMatchObject({
      title: "好吗好的",
      progressPercent: 59,
      lastReadAt: 1717200000000,
      status: "reading"
    });
  });

  test("uses WeRead finishStatus instead of progress to classify shelf books", () => {
    const books = syncReadingWereadShelf([
      {
        bookInfo: {
          bookId: "wr-progress-100",
          title: "踏星"
        },
        readingProgress: 100,
        finishStatus: 0
      },
      {
        bookInfo: {
          bookId: "wr-finished",
          title: "已读完"
        },
        readingProgress: 20,
        finishStatus: 1
      }
    ]);

    expect(books.find((book) => book.source.externalId === "wr-progress-100")).toMatchObject({
      progressPercent: 100,
      status: "reading"
    });
    expect(books.find((book) => book.source.externalId === "wr-finished")).toMatchObject({
      progressPercent: 20,
      status: "finished"
    });
  });

  test("syncs official WeRead readUpdateTime into stored latest read time", () => {
    const books = syncReadingWereadShelf([
      {
        bookInfo: {
          bookId: "wr-latest",
          title: "踏星",
          author: "随散飘风",
          readUpdateTime: 1717300000
        },
        progress: 47
      }
    ]);

    expect(books.find((book) => book.source.externalId === "wr-latest")).toMatchObject({
      title: "踏星",
      progressPercent: 47,
      lastReadAt: 1717300000000
    });
  });

  test("syncs official WeRead finishedDate into finished reading status", () => {
    const books = syncReadingWereadShelf([
      {
        bookInfo: {
          bookId: "wr-finished-date",
          title: "已读完的书",
          finishedDate: 1717300000
        }
      }
    ]);

    expect(books.find((book) => book.source.externalId === "wr-finished-date")).toMatchObject({
      title: "已读完的书",
      status: "finished",
      lastReadAt: 1717300000000
    });
  });

  test("persists Alice-like reading note context and revisions", () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      source: {
        kind: "weread",
        externalId: "wr-1",
        title: "我在北京送快递"
      },
      progressPercent: 54
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "身体在场",
      depth: "deep",
      noteKind: "insight",
      chapterTitle: "通勤",
      summary: "普通劳动被写成具体生活。",
      body: "Lume 把这段读成一种对身体位置的确认。",
      excerpt: "把自己看作一个普通人，过普通人的生活。",
      progressPercent: 54,
      originalQuote: "把自己看作一个普通人，过普通人的生活。",
      mood: "安静",
      userContext: "用户在这段旁边停留，并标记了普通人的日常。",
      selfContext: "Lume 想把它和自己最近的等待感连起来。",
      rating: 4,
      cost: 0.0123,
      modelUsage: {
        modelRef: "test/deep-reader",
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200
      },
      tags: ["身体在场"],
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
      ],
      nextPlan: "继续看身体经验如何变成关系经验。"
    });

    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      id: note.id,
      noteKind: "insight",
      chapterTitle: "通勤",
      originalQuote: "把自己看作一个普通人，过普通人的生活。",
      mood: "安静",
      userContext: "用户在这段旁边停留，并标记了普通人的日常。",
      selfContext: "Lume 想把它和自己最近的等待感连起来。",
      rating: 4,
      cost: 0.0123,
      modelUsage: {
        modelRef: "test/deep-reader",
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200
      },
      revisions: []
    });

    const revised = reviseReadingNote({
      id: note.id,
      body: "重新读这段时，Lume 更关心那种被日常磨出来的确认感。",
      summary: "修订后更聚焦日常确认感。",
      editReason: "把判断从抽象劳动改到具体日常。",
      modelRef: "test/reviser"
    });

    expect(revised.body).toBe("重新读这段时，Lume 更关心那种被日常磨出来的确认感。");
    expect(revised.summary).toBe("修订后更聚焦日常确认感。");
    expect(revised.lastEditedAt).toBeNumber();
    const revisions = revised.revisions ?? [];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      editReason: "把判断从抽象劳动改到具体日常。",
      modelRef: "test/reviser",
      previousBody: "Lume 把这段读成一种对身体位置的确认。"
    });
  });

  test("summarizes Lume's current self-reading activity in the snapshot", () => {
    addReadingBook({
      title: "Frankenstein",
      author: "Mary Shelley",
      track: "lume",
      source: {
        kind: "gutenberg",
        externalId: "84"
      },
      progressPercent: 12
    });
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      source: {
        kind: "weread",
        externalId: "wr-1",
        title: "我在北京送快递"
      },
      progressPercent: 54
    });
    const note = createReadingNote({
      bookId: book.id,
      title: "身体在场",
      depth: "deep",
      summary: "普通劳动被写成具体生活。",
      body: "Lume 把这段读成一种对身体位置的确认。",
      excerpt: "把自己看作一个普通人，过普通人的生活。",
      progressPercent: 54,
      selfContext: "Lume 想把它和自己最近的等待感连起来。",
      tags: ["身体在场"],
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
      ],
      nextPlan: "继续看身体经验如何变成关系经验。"
    });

    expect(getReadingSnapshot().activity).toMatchObject({
      currentBook: {
        id: book.id,
        title: "我在北京送快递",
        progressPercent: 54,
        track: "co_read"
      },
      latestNote: {
        id: note.id,
        title: "身体在场",
        summary: "普通劳动被写成具体生活。"
      },
      currentThought: "Lume 想把它和自己最近的等待感连起来。",
      nextPlan: "继续看身体经验如何变成关系经验。"
    });
  });

  // #592: 书架文件损坏必须先备份现场再回退空库——否则下一次写入会把整个
  // 书架物理覆盖为「空库+新书」，不可逆
  test("corrupt library file is backed up before falling back to an empty library", () => {
    initReadingStorage();
    addReadingBook({ title: "幸存的书" });
    // 先触发一次快照让 .bootstrapped 标记落盘：否则损坏回退空库后 bootstrap
    // 会重新种入 starter 书，断言与播种语义冲突
    getReadingSnapshot();

    writeFileSync(getReadingLibraryPath(), "{ broken json", "utf8");
    const snapshot = getReadingSnapshot();

    expect(snapshot.books).toHaveLength(0);
    const backups = readdirSync(getReadingDir()).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    // 备份保留损坏原文，供人工恢复
    expect(readFileSync(join(getReadingDir(), backups[0]!), "utf8")).toBe("{ broken json");
    // 自愈闭环：损坏现场移走后写路径正常工作，新写入不含损坏内容。
    // （snapshot 过程中 initReadingStorage 会重建缺失的 library.json 空壳，
    // 因此不能断言文件不存在）
    addReadingBook({ title: "新书" });
    expect(listReadingBooks().map((item) => item.title)).toEqual(["新书"]);
  });

  // 结构漂移（合法 JSON 但 books 非数组）同样触发备份（#592）
  test("structurally drifted library file is also backed up, not silently emptied", () => {
    initReadingStorage();
    addReadingBook({ title: "书" });
    getReadingSnapshot();

    writeFileSync(getReadingLibraryPath(), JSON.stringify({ version: 1, books: 5 }), "utf8");
    const snapshot = getReadingSnapshot();

    expect(snapshot.books).toHaveLength(0);
    const backups = readdirSync(getReadingDir()).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  // #597: 单条读取直读文件；损坏的笔记文件不拖垮单条查询
  test("getReadingNote reads a single note by id without a directory scan", () => {
    initReadingStorage();
    const book = addReadingBook({ title: "书" });
    const note = createReadingNote({
      bookId: book.id,
      title: "直读",
      body: "内容"
    });

    expect(getReadingNote(note.id)?.id).toBe(note.id);
    expect(getReadingNote("no-such-note")).toBeNull();
    // 非法 id（白名单外）安全返回 null 而非抛错
    expect(getReadingNote("../escape")).toBeNull();
    // 损坏的笔记文件：单条查询降级为 null 而非抛错（与列表路径同分诊）
    writeFileSync(join(getReadingNotesDir(), "broken.md"), "---\ntitle: 残骸\n", "utf8");
    expect(getReadingNote("broken")).toBeNull();
  });

});
