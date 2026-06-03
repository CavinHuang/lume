import { describe, expect, test } from "bun:test";
import { WereadClient } from "./weread-client";

describe("WereadClient", () => {
  test("uses Alice-like WeRead endpoints for shelf, marks, reviews, read data, and search", async () => {
    const urls: string[] = [];
    const client = new WereadClient({
      apiKey: "secret-key",
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ books: [], bookmarks: [], reviews: [], items: [] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    });

    await client.shelf();
    await client.bookmarks("wr-1");
    await client.reviews("wr-1");
    await client.readdata("week");
    await client.search("置身事内", 3);

    expect(urls).toContain("https://weread.qq.com/shelf/sync");
    expect(urls).toContain("https://weread.qq.com/book/bookmarklist?bookId=wr-1");
    expect(urls).toContain("https://weread.qq.com/review/list/mine?bookid=wr-1&count=50&synckey=0");
    expect(urls).toContain("https://weread.qq.com/readdata/detail?mode=week");
    expect(urls).toContain("https://weread.qq.com/web/search/global?keyword=%E7%BD%AE%E8%BA%AB%E4%BA%8B%E5%86%85&maxIdx=0&count=3");
  });
});
