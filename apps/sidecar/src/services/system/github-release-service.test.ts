import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearGitHubReleaseCache,
  getGitHubReleaseByTag,
  getLatestGitHubRelease,
  listGitHubReleases
} from "./github-release-service";

function makeRelease(input: Partial<{
  id: number;
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  html_url: string;
}> = {}) {
  return {
    id: input.id ?? 1,
    tag_name: input.tag_name ?? "v0.1.0",
    name: input.name ?? "v0.1.0",
    body: input.body ?? "notes",
    draft: input.draft ?? false,
    prerelease: input.prerelease ?? false,
    created_at: input.created_at ?? "2026-03-22T00:00:00.000Z",
    published_at: input.published_at ?? "2026-03-22T00:00:00.000Z",
    html_url: input.html_url ?? "https://github.com/ErlichLiu/Lume/releases/tag/v0.1.0"
  };
}

describe("github-release-service", () => {
  let previousFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    previousFetch = globalThis.fetch;
    clearGitHubReleaseCache();
  });

  afterEach(() => {
    if (previousFetch) {
      globalThis.fetch = previousFetch;
    }
    clearGitHubReleaseCache();
  });

  test("listGitHubReleases 应过滤 prerelease/draft 并按 perPage 返回", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          makeRelease({ id: 1, tag_name: "v1.2.0" }),
          makeRelease({ id: 2, tag_name: "v1.1.0", prerelease: true }),
          makeRelease({ id: 3, tag_name: "v1.0.0" }),
          makeRelease({ id: 4, tag_name: "v0.9.0", draft: true })
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )) as unknown as typeof fetch;

    const list = await listGitHubReleases({
      perPage: 2,
      includePrerelease: false
    });
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.tag_name)).toEqual(["v1.2.0", "v1.0.0"]);
  });

  test("listGitHubReleases 在后续请求失败时应回退到缓存", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify([makeRelease({ id: 10, tag_name: "v2.0.0" })]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const first = await listGitHubReleases({ perPage: 5 });
    expect(first).toHaveLength(1);
    expect(first[0]?.tag_name).toBe("v2.0.0");

    const second = await listGitHubReleases({ perPage: 5, page: 2 });
    expect(second).toHaveLength(1);
    expect(second[0]?.tag_name).toBe("v2.0.0");
  });

  test("getLatestGitHubRelease 和 getGitHubReleaseByTag 应返回对应 release", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/releases/latest")) {
        return new Response(JSON.stringify(makeRelease({ id: 100, tag_name: "v3.0.0" })), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/releases/tags/v2.5.0")) {
        return new Response(JSON.stringify(makeRelease({ id: 90, tag_name: "v2.5.0" })), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const latest = await getLatestGitHubRelease();
    expect(latest?.tag_name).toBe("v3.0.0");

    const byTag = await getGitHubReleaseByTag("v2.5.0");
    expect(byTag?.tag_name).toBe("v2.5.0");
  });
});
