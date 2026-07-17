import { describe, expect, test } from "bun:test";
import { buildWereadReadingProfile } from "./weread-reading-profile";

describe("buildWereadReadingProfile", () => {
  test("cross-analyzes shelf, notebook depth, archives, and recent activity", () => {
    const now = Date.UTC(2026, 6, 17);
    const profile = buildWereadReadingProfile({
      books: [
        {
          bookInfo: {
            bookId: "heavy",
            title: "深读之书",
            author: "作者甲",
            deepLink: "weread://reading?bId=heavy"
          },
          readingProgress: 80,
          readUpdateTime: Math.floor((now - 3 * 24 * 60 * 60 * 1000) / 1000)
        },
        { bookId: "skimmed", title: "浅尝之书", readUpdateTime: 1_700_000_000 },
        { bookId: "unread", title: "收藏未读" }
      ],
      archive: [
        { name: "产品", bookIds: ["heavy", "unread"] },
        { title: "今年想读", books: [{ bookId: "unread" }] }
      ]
    }, {
      books: [
        { bookId: "heavy", bookmarkCount: 7, noteCount: 12, reviewCount: 2 },
        { bookId: "skimmed", noteCount: 2 },
        { bookId: "hidden", title: "借阅但深读", bookmarkCount: 1, noteCount: 10 }
      ]
    }, now);

    expect(profile.summary).toEqual({
      shelfBookCount: 3,
      notebookBookCount: 3,
      actuallyReadCount: 2,
      shelvedUnreadCount: 1,
      hiddenDeepCount: 1,
      recentActiveCount: 1
    });
    expect(profile.categories).toEqual([
      { name: "产品", bookCount: 2 },
      { name: "今年想读", bookCount: 1 }
    ]);
    expect(profile.buckets.deep[0]).toMatchObject({
      bookId: "heavy",
      noteCount: 12,
      progressPercent: 80,
      lastReadDate: "2026-07-14",
      categories: ["产品"],
      openUrl: "weread://reading?bId=heavy",
      actuallyRead: true,
      activeInLast30Days: true
    });
    expect(profile.buckets.light[0]).toMatchObject({ bookId: "skimmed", noteCount: 2 });
    expect(profile.buckets.shelvedUnread[0]).toMatchObject({ bookId: "unread", noteCount: 0 });
    expect(profile.buckets.hiddenDeep[0]).toMatchObject({
      bookId: "hidden",
      noteCount: 10,
      inShelf: false,
      openUrl: "weread://reading?bId=hidden"
    });
    expect(profile.recent.map((book) => book.bookId)).toEqual(["heavy", "skimmed"]);
    expect(profile.warnings).toEqual([]);
  });

  test("makes empty-data fallbacks explicit", () => {
    const profile = buildWereadReadingProfile({ books: [] }, { books: [] }, 0);

    expect(profile.summary.shelfBookCount).toBe(0);
    expect(profile.summary.notebookBookCount).toBe(0);
    expect(profile.warnings).toHaveLength(2);
  });
});
