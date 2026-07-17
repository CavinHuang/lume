import { describe, expect, test } from "bun:test";
import { WereadClient } from "./weread-client";

describe("WereadClient", () => {
  test("uses the official WeRead Skill API gateway for shelf, marks, reviews, read data, and search", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      auth?: string | null;
      contentType?: string | null;
      body: Record<string, unknown>;
    }> = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          auth: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify({ books: [], updated: [], reviews: [], items: [], results: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    });

    await client.shelf();
    await client.notebooks();
    await client.bookmarks("wr-1");
    await client.reviews("wr-1");
    await client.readdata("week");
    await client.search("置身事内", 3);

    expect(calls.map((call) => call.url)).toEqual(Array.from({ length: 6 }, () => "https://i.weread.qq.com/api/agent/gateway"));
    expect(calls.every((call) => call.method === "POST")).toBeTrue();
    expect(calls.every((call) => call.auth === "Bearer secret-key")).toBeTrue();
    expect(calls.every((call) => call.contentType?.includes("application/json"))).toBeTrue();
    expect(calls.map((call) => call.body)).toEqual([
      { api_name: "/shelf/sync", skill_version: "1.0.4" },
      { api_name: "/user/notebooks", count: 500, skill_version: "1.0.4" },
      { api_name: "/book/bookmarklist", bookId: "wr-1", skill_version: "1.0.4" },
      { api_name: "/review/list/mine", bookid: "wr-1", count: 50, synckey: 0, skill_version: "1.0.4" },
      { api_name: "/readdata/detail", mode: "weekly", skill_version: "1.0.4" },
      { api_name: "/store/search", keyword: "置身事内", scope: 10, maxIdx: 0, count: 3, skill_version: "1.0.4" }
    ]);
    expect(calls.some((call) => "params" in call.body)).toBeFalse();
  });

  test("maps gateway shelf totals and nested search results", async () => {
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { api_name?: string };
        if (body.api_name === "/shelf/sync") {
          return jsonResponse({
            books: [
              {
                bookInfo: {
                  bookId: "wr-1",
                  title: "我在北京送快递",
                  author: "胡安焉",
                  cover: "https://cover.example.com/wr-1.jpg"
                },
                readingProgress: 59,
                lastReadTime: 1717200000
              },
              {
                bookId: "wr-done",
                title: "好吗好的",
                author: "大冰",
                progress: 100,
                finishStatus: 0
              },
              {
                bookId: "wr-finish-status",
                title: "读完的书",
                finishStatus: 1
              }
            ],
            albums: [{ albumInfo: { albumId: "album-1", name: "听书" } }],
            mp: { name: "文章收藏" }
          });
        }
        return jsonResponse({
          results: [
            {
              books: [
                {
                  bookInfo: {
                    bookId: "wr-2",
                    title: "置身事内",
                    author: "兰小欢"
                  }
                }
              ]
            }
          ]
        });
      }
    });

    const books = await client.shelf();
    expect(books).toMatchObject([
      {
        title: "我在北京送快递",
        source: { externalId: "wr-1" },
        progressPercent: 59,
        lastReadAt: 1717200000000,
        status: "reading"
      },
      {
        title: "好吗好的",
        source: { externalId: "wr-done" },
        progressPercent: 100,
        status: "reading"
      },
      {
        title: "读完的书",
        source: { externalId: "wr-finish-status" },
        status: "finished"
      }
    ]);
    await expect(client.shelfStats()).resolves.toEqual({
      total: 5,
      bookCount: 3,
      albumCount: 1,
      mpCount: 1
    });
    await expect(client.search("置身事内", 3)).resolves.toMatchObject([
      {
        title: "置身事内",
        source: "weread",
        externalId: "wr-2"
      }
    ]);
  });

  test("enriches shelf books with getprogress progress and official latest read time", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push(body);
        if (body.api_name === "/shelf/sync") {
          return jsonResponse({
            books: [
              {
                bookInfo: {
                  bookId: "wr-progress",
                  title: "好吗好的",
                  author: "大冰",
                  cover: "https://cover.example.com/ok.jpg",
                  deepLink: "weread://reading?bId=wr-progress",
                  readUpdateTime: 1717300000
                }
              }
            ]
          });
        }
        if (body.api_name === "/book/getprogress") {
          return jsonResponse({
            book: {
              bookId: body.bookId,
              progress: 59
            }
          });
        }
        return jsonResponse({});
      }
    });

    const books = await client.shelf();
    expect(books).toMatchObject([
      {
        title: "好吗好的",
        source: { externalId: "wr-progress" },
        progressPercent: 59,
        lastReadAt: 1717300000000,
        status: "reading"
      }
    ]);
    expect(books[0]?.source?.url).toBe("weread://reading?bId=wr-progress");
    expect(calls.map((call) => call.api_name)).toEqual([
      "/shelf/sync",
      "/book/getprogress"
    ]);
    expect(calls[1]).toMatchObject({
      bookId: "wr-progress"
    });
  });

  test("requests accumulated WeRead read data with official total mode", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push(body);
        return jsonResponse({ totalDays: 564, readTime: 2851200 });
      }
    });

    await expect(client.readdata("all", 0)).resolves.toEqual({
      totalDays: 564,
      readTime: 2851200
    });
    expect(calls[0]).toMatchObject({
      api_name: "/readdata/detail",
      mode: "overall",
      baseTime: 0
    });
  });

  test("limits progress enrichment to the five most recently read shelf books", async () => {
    const progressBookIds: string[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.api_name === "/shelf/sync") {
          return jsonResponse({
            books: Array.from({ length: 7 }, (_, index) => ({
              bookId: `wr-${index + 1}`,
              title: `第 ${index + 1} 本`,
              readUpdateTime: index + 1
            }))
          });
        }
        if (body.api_name === "/book/getprogress") {
          progressBookIds.push(String(body.bookId));
          return jsonResponse({ book: { bookId: body.bookId, progress: 50 } });
        }
        return jsonResponse({});
      }
    });

    const books = await client.shelf();

    expect(progressBookIds).toEqual(["wr-7", "wr-6", "wr-5", "wr-4", "wr-3"]);
    expect(books.find((book) => book.source?.externalId === "wr-7")?.progressPercent).toBe(50);
    expect(books.find((book) => book.source?.externalId === "wr-2")?.progressPercent).toBeUndefined();
  });

  test("calls the official detail, chapter, and recommendation APIs with required paging parameters", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({});
      }
    });

    await client.bookInfo("wr-1");
    await client.chapters("wr-1");
    await client.recommendations();
    await client.similarBooks("wr-1", 8, 20, "session-1");

    expect(calls).toEqual([
      { api_name: "/book/info", bookId: "wr-1", skill_version: "1.0.4" },
      { api_name: "/book/chapterinfo", bookId: "wr-1", skill_version: "1.0.4" },
      { api_name: "/book/recommend", count: 12, maxIdx: 0, skill_version: "1.0.4" },
      { api_name: "/book/similar", bookId: "wr-1", count: 8, maxIdx: 20, sessionId: "session-1", skill_version: "1.0.4" }
    ]);
  });

  test("classifies WeRead books with finishedDate as finished", async () => {
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.api_name === "/shelf/sync") {
          return jsonResponse({
            books: [
              {
                bookInfo: {
                  bookId: "wr-finished-date",
                  title: "已读完的书",
                  finishedDate: 1717300000
                }
              }
            ]
          });
        }
        return jsonResponse({});
      }
    });

    await expect(client.shelf()).resolves.toMatchObject([
      {
        title: "已读完的书",
        status: "finished"
      }
    ]);
  });

  test("paginates official WeRead notebooks by lastSort", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push(body);
        if (body.api_name === "/user/notebooks" && body.lastSort === undefined) {
          return jsonResponse({
            books: [{ bookId: "wr-1", sort: 90, title: "第一本" }],
            hasMore: 1
          });
        }
        if (body.api_name === "/user/notebooks" && body.lastSort === 90) {
          return jsonResponse({
            books: [{ bookId: "wr-2", sort: 80, title: "第二本" }],
            hasMore: 0,
            lastSort: 80
          });
        }
        return jsonResponse({});
      }
    });

    await expect(client.notebooks()).resolves.toMatchObject([
      { bookId: "wr-1", title: "第一本" },
      { bookId: "wr-2", title: "第二本" }
    ]);
    expect(calls.map((call) => call.api_name)).toEqual([
      "/user/notebooks",
      "/user/notebooks"
    ]);
    expect(calls[1]).toMatchObject({
      count: 500,
      lastSort: 90
    });
  });

  test("paginates personal WeRead reviews by synckey", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push(body);
        if (body.api_name === "/review/list/mine" && body.synckey === 0) {
          return jsonResponse({
            reviews: [{ reviewId: "r1", content: "第一条想法" }],
            hasMore: 1,
            synckey: 123
          });
        }
        if (body.api_name === "/review/list/mine" && body.synckey === 123) {
          return jsonResponse({
            reviews: [{ reviewId: "r2", content: "第二条想法" }],
            hasMore: 0,
            synckey: 456
          });
        }
        return jsonResponse({});
      }
    });

    await expect(client.reviews("wr-1")).resolves.toEqual([
      { reviewId: "r1", content: "第一条想法" },
      { reviewId: "r2", content: "第二条想法" }
    ]);
    expect(calls.map((call) => call.synckey)).toEqual([0, 123]);
  });

  test("maps bookmark chapter titles from WeRead chapter lists before returning to the UI", async () => {
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.api_name === "/book/bookmarklist") {
          return jsonResponse({
            chapters: [{ chapterUid: 1001, title: "最后一个义工" }],
            updated: [{ bookmarkId: "b1", chapterUid: 1001, range: "120-138", markText: "先好好去挣钱。" }]
          });
        }
        if (body.api_name === "/book/bestbookmarks") {
          return jsonResponse({
            book: { title: "好吗好的", author: "大冰" },
            chapters: [{ chapterUid: 2001, title: "我的想法" }],
            items: [{ chapterUid: 2001, markText: "米饭和时间能让你酿出一首歌。", totalCount: 12 }]
          });
        }
        return jsonResponse({});
      }
    });

    await expect(client.bookmarks("wr-1")).resolves.toMatchObject([
      {
        bookmarkId: "b1",
        chapterTitle: "最后一个义工",
        openUrl: "weread://bestbookmark?bookId=wr-1&chapterUid=1001&rangeStart=120&rangeEnd=138"
      }
    ]);
    await expect(client.bestBookmarks("wr-1")).resolves.toMatchObject([
      {
        markText: "米饭和时间能让你酿出一首歌。",
        chapterTitle: "我的想法",
        bookTitle: "好吗好的",
        bookAuthor: "大冰"
      }
    ]);
  });

  test("flattens chapter-grouped WeRead bookmarks into UI-ready highlights", async () => {
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async () => jsonResponse({
        chapters: [
          {
            chapterUid: 1001,
            chapterName: "最后一个义工",
            items: [
              {
                bookmarkId: "b1",
                markText: "没资格谈论理想时，先好好去挣钱。",
                createTime: 1538352000
              }
            ]
          }
        ],
        items: [{ chapterUid: 1001, title: "最后一个义工" }]
      })
    });

    await expect(client.bookmarks("wr-1")).resolves.toEqual([
      {
        bookmarkId: "b1",
        markText: "没资格谈论理想时，先好好去挣钱。",
        createTime: 1538352000,
        chapterUid: 1001,
        chapterTitle: "最后一个义工"
      }
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
