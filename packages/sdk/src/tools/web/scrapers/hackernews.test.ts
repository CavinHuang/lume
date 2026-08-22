import { describe, expect, test } from "bun:test";
import { handleHackerNews } from "./hackernews.js";

describe("handleHackerNews hostname gate (#371)", () => {
  // Under the fixed exact-host gate these return null before any fetch; under
  // the old substring match the handler accepted them and produced an error
  // render result instead of null.
  test("lookalike hostnames are ignored", async () => {
    for (const url of [
      "https://news.ycombinator.com.evil.example/item?id=1",
      "https://news.ycombinator.com.bad.io/",
      "https://evil.example/?u=https://news.ycombinator.com/item?id=1",
      "https://not-news.ycombinator.com.example/item?id=1",
    ]) {
      expect(await handleHackerNews(url, 1000)).toBeNull();
    }
  });

  test("unrelated hosts are ignored", async () => {
    for (const url of [
      "https://example.org/item?id=1",
      "https://ycombinator.com/",
      "https://hn.algolia.com/item?id=1",
    ]) {
      expect(await handleHackerNews(url, 1000)).toBeNull();
    }
  });
});
