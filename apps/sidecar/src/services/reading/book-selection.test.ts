import { describe, expect, test } from "bun:test";
import type { ReadingBook, ReadingNote } from "@lume/shared";
import {
  hasReachedWeeklyDeepNoteLimit,
  selectNextReadingBook
} from "./book-selection";

describe("reading book selection", () => {
  test("prefers co-reading books before Lume public reading when available", () => {
    const publicBook = createBook({ id: "book-public", track: "lume", updatedAt: 20 });
    const coReadingBook = createBook({ id: "book-user", track: "co_read", updatedAt: 10 });

    expect(selectNextReadingBook([publicBook, coReadingBook])?.id).toBe("book-user");
  });

  test("honors an explicit book id before automatic selection", () => {
    const publicBook = createBook({ id: "book-public", track: "lume" });
    const coReadingBook = createBook({ id: "book-user", track: "co_read" });

    expect(selectNextReadingBook([publicBook, coReadingBook], { bookId: "book-public" })?.id).toBe("book-public");
  });

  test("detects the weekly deep note limit", () => {
    const now = 10_000;
    const notes = [
      createNote({ id: "deep-1", depth: "deep", createdAt: now - 1_000 }),
      createNote({ id: "seed-1", depth: "seed", createdAt: now - 500 })
    ];

    expect(hasReachedWeeklyDeepNoteLimit(notes, now, 1)).toBeTrue();
    expect(hasReachedWeeklyDeepNoteLimit(notes, now, 2)).toBeFalse();
  });
});

function createBook(overrides: Partial<ReadingBook>): ReadingBook {
  return {
    id: "book-1",
    title: "我在北京送快递",
    track: "lume",
    status: "reading",
    source: {
      kind: "weread",
      excerpt: "把自己看作一个普通人，过普通人的生活。"
    },
    tags: [],
    addedAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function createNote(overrides: Partial<ReadingNote>): ReadingNote {
  return {
    id: "note-1",
    bookId: "book-1",
    title: "读书札记",
    depth: "seed",
    summary: "summary",
    body: "body",
    tags: [],
    evidence: [],
    aiGenerated: true,
    hidden: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}
