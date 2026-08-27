import { describe, expect, test } from "bun:test";
import { BookDataService } from "./book-data-service";

describe("BookDataService", () => {
  test("maps WeRead search without exposing the API Key", async () => {
    const calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
    const service = new BookDataService({
      wereadApiKey: "secret-key",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization") ?? undefined,
          body
        });
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

    await expect(service.searchWeread("置身事内", 3)).resolves.toMatchObject({
      ok: true,
      data: [
        {
          title: "置身事内",
          source: "weread",
          externalId: "wr-2"
        }
      ]
    });
    expect(calls.every((call) => call.auth === "Bearer secret-key")).toBeTrue();
    expect(calls.every((call) => call.url === "https://i.weread.qq.com/api/agent/gateway")).toBeTrue();
    expect(calls.map((call) => call.body.api_name)).toContain("/store/search");
    expect(calls.find((call) => call.body.api_name === "/store/search")?.body).toMatchObject({
      keyword: "置身事内",
      scope: 10,
      maxIdx: 0,
      count: 3
    });
  });

  test("returns typed partial errors for source failures", async () => {
    const service = new BookDataService({
      fetch: async () => {
        throw new Error("network down");
      }
    });

    await expect(service.searchWereadPublic("anything")).resolves.toEqual({
      ok: false,
      error: "network down",
      data: []
    });
  });

  test("loads Alice-like WeRead companion data", async () => {
    const seenApiNames: unknown[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const service = new BookDataService({
      wereadApiKey: "secret-key",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seenApiNames.push(body.api_name);
        seenBodies.push(body);
        if (body.api_name === "/book/bestbookmarks") {
          return jsonResponse({
            items: [
              {
                markText: "把自己看作一个普通人，过普通人的生活。",
                totalCount: 1200,
                chapterName: "通勤"
              }
            ],
            book: {
              title: "我在北京送快递",
              author: "胡安焉"
            }
          });
        }
        return jsonResponse({});
      }
    });

    await expect(service.loadWereadBestBookmarks("wr-1")).resolves.toMatchObject({
      ok: true,
      data: [
        {
          markText: "把自己看作一个普通人，过普通人的生活。",
          totalCount: 1200,
          chapterTitle: "通勤",
          bookTitle: "我在北京送快递"
        }
      ]
    });
    expect(seenApiNames).toContain("/book/bestbookmarks");
    expect(seenBodies.find((body) => body.api_name === "/book/bestbookmarks")).toMatchObject({
      bookId: "wr-1",
      chapterUid: 0,
      synckey: 0
    });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
