import { describe, expect, test } from "bun:test";
import { handleSpecialUrl, specialHandlerNames } from "./index.js";

describe("WebFetch special handlers", () => {
  test("registers the oh-my-pi site categories", () => {
    expect(specialHandlerNames.length).toBeGreaterThanOrEqual(75);
    for (const name of ["github", "npm", "reddit", "youtube", "arxiv", "wikipedia"]) expect(specialHandlerNames).toContain(name);
  });

  test("GitHub API handler emits structured output", async () => {
    const calls: string[] = [];
    const result = await handleSpecialUrl("https://github.com/lume-ai/lume", {
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [] }), { headers: { "content-type": "application/json" } });
        if (url.endsWith("/readme")) return new Response(JSON.stringify({ content: Buffer.from("# README").toString("base64"), encoding: "base64" }), { headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ full_name: "lume-ai/lume", description: "Lume", stargazers_count: 1, forks_count: 1, open_issues_count: 0, default_branch: "main", language: "TypeScript", license: { name: "MIT" } }), { headers: { "content-type": "application/json" } });
      },
    });
    expect(calls[0]).toContain("api.github.com/repos/lume-ai/lume");
    expect(result?.url).toBe("https://github.com/lume-ai/lume");
    expect(result?.method).toBe("github-repo");
    expect(result?.contentType).toBe("text/markdown");
    expect(result?.fetchedAt).toBeTruthy();
    expect(result?.notes).toContain("Fetched via GitHub API");
    expect(result?.content).toContain("lume-ai/lume");
  });

  test("all registered site handlers have a runnable migration path", async () => {
    const cases: Array<[string, string]> = [
      ["github-gist", "https://gist.github.com/user/abc123"], ["github", "https://github.com/o/r"], ["gitlab", "https://gitlab.com/o/r"],
      ["youtube", "https://youtube.com/watch?v=abcdefghijk"], ["vimeo", "https://vimeo.com/123"], ["spotify", "https://open.spotify.com/track/abc"], ["discogs", "https://discogs.com/release/1"], ["musicbrainz", "https://musicbrainz.org/artist/abc"], ["rawg", "https://rawg.io/games/demo"],
      ["twitter", "https://x.com/user/status/123"], ["bluesky", "https://bsky.app/profile/user.test"], ["mastodon", "https://mastodon.social/@user"], ["lemmy", "https://lemmy.world/post/1"], ["hackernews", "https://news.ycombinator.com/item?id=1"], ["lobsters", "https://lobste.rs/s/abc"], ["reddit", "https://www.reddit.com/r/test/comments/abc/title"], ["discourse", "https://discourse.example.com/t/topic/1"],
      ["stackoverflow", "https://stackoverflow.com/questions/1/test"], ["devto", "https://dev.to/user/article"], ["mdn", "https://developer.mozilla.org/en-US/docs/Web/JavaScript"], ["docs-rs", "https://docs.rs/crate/demo/1.0"], ["readthedocs", "https://demo.readthedocs.io/en/latest/"], ["searchcode", "https://searchcode.com/view/123"], ["sourcegraph", "https://sourcegraph.com/github.com/o/r"], ["tldr", "https://tldr.sh/git"], ["cheatsh", "https://cheat.sh/git"],
      ["npm", "https://www.npmjs.com/package/demo"], ["firefox-addons", "https://addons.mozilla.org/en-US/firefox/addon/demo"], ["vscode-marketplace", "https://marketplace.visualstudio.com/items?itemName=o.demo"], ["nuget", "https://www.nuget.org/packages/Demo"], ["chocolatey", "https://community.chocolatey.org/packages/demo"], ["clojars", "https://clojars.org/artifacts/demo/demo"], ["brew", "https://formulae.brew.sh/formula/demo"], ["pypi", "https://pypi.org/project/demo"], ["crates-io", "https://crates.io/crates/demo"], ["dockerhub", "https://hub.docker.com/r/library/demo"], ["fdroid", "https://f-droid.org/packages/org.demo"], ["flathub", "https://flathub.org/apps/org.demo"], ["go-pkg", "https://pkg.go.dev/example.com/demo"], ["hex", "https://hex.pm/packages/demo"], ["packagist", "https://packagist.org/packages/vendor/demo"], ["pub-dev", "https://pub.dev/packages/demo"], ["maven", "https://search.maven.org/artifact/com.example/demo/1.0"], ["jetbrains-marketplace", "https://plugins.jetbrains.com/plugin/123"], ["open-vsx", "https://open-vsx.org/extension/o/demo"], ["artifacthub", "https://artifacthub.io/packages/helm/repo/demo"], ["rubygems", "https://rubygems.org/gems/demo"], ["terraform", "https://registry.terraform.io/modules/hashicorp/consul/aws"], ["aur", "https://aur.archlinux.org/packages/demo"], ["hackage", "https://hackage.haskell.org/package/demo"], ["metacpan", "https://metacpan.org/module/Demo"], ["repology", "https://repology.org/project/demo/versions"], ["snapcraft", "https://snapcraft.io/demo"],
      ["huggingface", "https://huggingface.co/models/org/demo"], ["ollama", "https://ollama.com/library/demo"], ["arxiv", "https://arxiv.org/abs/1234.5678"], ["biorxiv", "https://www.biorxiv.org/content/10.1"], ["crossref", "https://doi.org/10.1234/demo"], ["iacr", "https://eprint.iacr.org/1234"], ["orcid", "https://orcid.org/0000-0000-0000-0000"], ["semantic-scholar", "https://www.semanticscholar.org/paper/abc"], ["pubmed", "https://pubmed.ncbi.nlm.nih.gov/123"], ["rfc", "https://www.rfc-editor.org/rfc/rfc1"], ["cisa-kev", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?CVE-2024-1234"], ["nvd", "https://nvd.nist.gov/vuln/detail/CVE-2024-1234"], ["osv", "https://osv.dev/vulnerability/CVE-2024-1234"], ["coingecko", "https://www.coingecko.com/en/coins/bitcoin"], ["opencorporates", "https://opencorporates.com/companies/gb/123"], ["sec-edgar", "https://www.sec.gov/Archives/edgar/data/1234"], ["openlibrary", "https://openlibrary.org/works/OL1W"], ["choosealicense", "https://choosealicense.com/licenses/mit"], ["w3c", "https://www.w3.org/specifications/demo"], ["spdx", "https://spdx.dev/licenses/MIT"], ["wikidata", "https://www.wikidata.org/wiki/Q42"], ["wikipedia", "https://en.wikipedia.org/wiki/Test"],
    ];
    expect(cases.length).toBe(specialHandlerNames.length);
    const fetchImpl = async (requestUrl: string, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("accept") || "";
      if (accept.includes("text/html") && !requestUrl.includes("api") && !requestUrl.includes("registry") && !requestUrl.includes("raw.githubusercontent")) {
        return new Response(`<html><body><article><h1>Fixture</h1><p>${"fixture content ".repeat(30)}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
      }
      if (requestUrl.includes("cisa.gov/sites/default")) {
        return new Response(JSON.stringify({ vulnerabilities: [{ cveID: "CVE-2024-1234", shortDescription: "fixture" }] }), { headers: { "content-type": "application/json" } });
      }
      if (requestUrl.includes("api.github.com/gists/")) {
        return new Response(JSON.stringify({ description: "fixture gist", owner: { login: "fixture" }, created_at: "2024-01-01", updated_at: "2024-01-02", files: { demo: { filename: "demo.ts", language: "TypeScript", content: "export {};" } } }), { headers: { "content-type": "application/json" } });
      }
      if (requestUrl.includes("api.github.com/repos/") && requestUrl.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [] }), { headers: { "content-type": "application/json" } });
      if (requestUrl.includes("api.github.com/repos/") && requestUrl.endsWith("/readme")) return new Response(JSON.stringify({ content: "", encoding: "base64" }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ full_name: "fixture/repo", description: "fixture", stargazers_count: 0, forks_count: 0, open_issues_count: 0, default_branch: "main", language: null, license: null }), { headers: { "content-type": "application/json" } });
    };
    for (const [name, url] of cases) {
      const result = await handleSpecialUrl(url, { timeoutMs: 1000, fetchImpl });
      expect(result === null || typeof result === "object", name).toBe(true);
    }
  });

  test("returns null on API failure so generic fetch can continue", async () => {
    const result = await handleSpecialUrl("https://github.com/o/r", {
      timeoutMs: 1000,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    expect(result).toBeNull();
  });
});
