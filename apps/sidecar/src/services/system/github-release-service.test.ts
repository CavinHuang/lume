import { describe, expect, test } from "bun:test";
import { getLatestGitHubRelease } from "./github-release-service";

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
  const previousFetch = globalThis.fetch;

  test("getLatestGitHubRelease 应返回对应 release", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(makeRelease({ id: 100, tag_name: "v3.0.0" })), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;

    const latest = await getLatestGitHubRelease();
    expect(latest?.tag_name).toBe("v3.0.0");
    globalThis.fetch = previousFetch;
  });

  test("getLatestGitHubRelease 网络失败时返回 null（fail-open）", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const latest = await getLatestGitHubRelease();
    expect(latest).toBeNull();
    globalThis.fetch = previousFetch;
  });
});
