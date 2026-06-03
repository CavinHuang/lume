import type { ReadingBook, ReadingNote, ReadingRunTaskInput } from "@lume/shared";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function selectNextReadingBook(
  books: ReadingBook[],
  input: Pick<ReadingRunTaskInput, "bookId"> = {}
): ReadingBook | null {
  if (input.bookId) {
    return books.find((book) => book.id === input.bookId) ?? null;
  }
  return [...books]
    .filter((book) => book.status !== "finished")
    .sort((a, b) => {
      const trackDelta = trackPriority(a) - trackPriority(b);
      if (trackDelta !== 0) return trackDelta;
      const statusDelta = statusPriority(a) - statusPriority(b);
      if (statusDelta !== 0) return statusDelta;
      return (b.lastReadAt ?? b.updatedAt) - (a.lastReadAt ?? a.updatedAt);
    })[0] ?? null;
}

export function hasReachedWeeklyDeepNoteLimit(notes: ReadingNote[], now: number, maxDeepNotesPerWeek: number): boolean {
  const limit = Math.max(1, maxDeepNotesPerWeek);
  const recentDeepCount = notes.filter((note) =>
    note.depth === "deep"
    && !note.deleted
    && note.createdAt >= now - WEEK_MS
  ).length;
  return recentDeepCount >= limit;
}

function trackPriority(book: ReadingBook): number {
  if (book.track === "co_read") return 0;
  if (book.track === "lume") return 1;
  return 2;
}

function statusPriority(book: ReadingBook): number {
  if (book.status === "reading") return 0;
  if (book.status === "queued") return 1;
  if (book.status === "paused") return 2;
  return 3;
}
