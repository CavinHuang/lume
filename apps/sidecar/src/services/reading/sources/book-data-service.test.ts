import { describe, expect, test } from "bun:test";
import { BookDataService } from "./book-data-service";

describe("BookDataService", () => {
  test("maps WeRead shelf and search without exposing the API Key", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const service = new BookDataService({
      wereadApiKey: "secret-key",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization") ?? undefined
        });
        if (String(url).includes("/shelf")) {
          return jsonResponse({
            books: [
              {
                bookId: "wr-1",
                title: "我在北京送快递",
                author: "胡安焉",
                cover: "https://cover.example.com/wr-1.jpg",
                progress: 54
              }
            ]
          });
        }
        return jsonResponse({
          books: [
            {
              bookInfo: {
                bookId: "wr-2",
                title: "置身事内",
                author: "兰小欢"
              }
            }
          ]
        });
      }
    });

    await expect(service.loadWereadShelf()).resolves.toMatchObject({
      ok: true,
      data: [
        {
          title: "我在北京送快递",
          source: {
            kind: "weread",
            externalId: "wr-1"
          },
          progressPercent: 54
        }
      ]
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
    expect(calls.some((call) => (
      call.url.includes("/web/search/global?keyword=")
      && call.url.includes("maxIdx=0")
      && call.url.includes("count=3")
    ))).toBeTrue();
    expect(JSON.stringify(await service.loadWereadShelf())).not.toContain("secret-key");
  });

  test("maps Gutenberg and poetry public source data", async () => {
    const service = new BookDataService({
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("gutendex")) {
          return jsonResponse({
            results: [
              {
                id: 84,
                title: "Frankenstein",
                authors: [{ name: "Mary Wollstonecraft Shelley" }],
                summaries: ["A public-domain novel about creation and responsibility."],
                formats: {
                  "image/jpeg": "https://gutenberg.example.com/frankenstein.jpg",
                  "text/plain; charset=utf-8": "https://gutenberg.example.com/84.txt"
                }
              }
            ]
          });
        }
        return jsonResponse({
          data: {
            content: "举头望明月，低头思故乡。",
            origin: {
              title: "静夜思",
              dynasty: "唐",
              author: "李白"
            }
          }
        });
      }
    });

    await expect(service.searchGutenberg("frankenstein", 1)).resolves.toMatchObject({
      ok: true,
      data: [
        {
          source: "gutenberg",
          externalId: "84",
          title: "Frankenstein",
          author: "Mary Wollstonecraft Shelley",
          coverUrl: "https://gutenberg.example.com/frankenstein.jpg"
        }
      ]
    });
    await expect(service.fetchPoem()).resolves.toMatchObject({
      ok: true,
      data: {
        source: "poetry",
        title: "静夜思",
        author: "李白",
        summary: "唐 · 李白：举头望明月，低头思故乡。"
      }
    });
  });

  test("returns typed partial errors for source failures", async () => {
    const service = new BookDataService({
      fetch: async () => {
        throw new Error("network down");
      }
    });

    await expect(service.searchGutenberg("anything")).resolves.toEqual({
      ok: false,
      error: "network down",
      data: []
    });
  });

  test("loads Alice-like WeRead companion data", async () => {
    const seenUrls: string[] = [];
    const service = new BookDataService({
      wereadApiKey: "secret-key",
      fetch: async (url) => {
        const href = String(url);
        seenUrls.push(href);
        if (href.includes("/notebook")) {
          return jsonResponse({
            notebooks: [
              {
                bookId: "wr-1",
                title: "我在北京送快递",
                author: "胡安焉",
                noteCount: 2
              }
            ]
          });
        }
        if (href.includes("/web/book/bestbookmarks")) {
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
        if (href.includes("/review")) {
          return jsonResponse({
            reviews: [
              {
                content: "这本书把普通劳动写得很具体。",
                reviewId: "review-1",
                likeCount: 88
              }
            ]
          });
        }
        return jsonResponse({});
      }
    });

    await expect(service.loadWereadNotebooks()).resolves.toMatchObject({
      ok: true,
      data: [{ title: "我在北京送快递", noteCount: 2 }]
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
    await expect(service.loadWereadPublicReviews("wr-1", "hot")).resolves.toMatchObject({
      ok: true,
      data: [
        {
          content: "这本书把普通劳动写得很具体。",
          reviewId: "review-1",
          likeCount: 88
        }
      ]
    });
    expect(seenUrls.some((url) => url.includes("/web/book/bestbookmarks?bookId=wr-1"))).toBeTrue();
    expect(seenUrls.some((url) => url.includes("listType=hot"))).toBeTrue();
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
