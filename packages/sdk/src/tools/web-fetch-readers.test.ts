import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { renderHtmlToMarkdown, type ReaderContext } from "./web-fetch-readers.js";

function makeContext(overrides: Partial<ReaderContext>): ReaderContext {
  return {
    url: "https://docs.example.com/x",
    html: "<html><body></body></html>",
    timeoutMs: 2000,
    fetchImpl: async () => new Response("unused", { status: 404 }),
    toolContext: { cwd: process.cwd() },
    ...overrides,
  } as ReaderContext;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("reader proxy domain whitelist (#200)", () => {
  test("jina reader refuses to proxy-fetch a target the sandbox denies", async () => {
    const fetched: string[] = [];
    const context = makeContext({
      url: "http://169.254.169.254/admin",
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["r.jina.ai"] },
      },
      fetchImpl: async (url: string) => {
        fetched.push(String(url));
        return new Response("# proxied secret", { headers: { "content-type": "text/markdown" } });
      },
    });

    const result = await renderHtmlToMarkdown(context, "jina");
    expect(result).toBeNull();
    expect(fetched).toEqual([]);
  });

  test("jina reader proceeds when both the proxy and the target are allowed", async () => {
    const fetched: string[] = [];
    const longMarkdown = "# Doc\n\n" + "proxied content line long enough to pass the low-quality heuristic\n".repeat(40);
    const context = makeContext({
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["r.jina.ai", "docs.example.com"] },
      },
      fetchImpl: async (url: string) => {
        fetched.push(String(url));
        return new Response(longMarkdown, { headers: { "content-type": "text/markdown" } });
      },
    });

    const result = await renderHtmlToMarkdown(context, "jina");
    expect(result?.method).toBe("jina");
    expect(fetched.length).toBeGreaterThanOrEqual(1);
    expect(fetched[0]).toContain("r.jina.ai/");
  });
});

describe("external readers parse locally, never fetch (#341)", () => {
  test("trafilatura receives a temp file instead of the URL, cleaned up afterwards", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let existedDuringCall: boolean | null = null;
    const longMarkdown = "# Extracted\n\n" + "reader output line long enough to pass quality heuristics\n".repeat(40);
    const context = makeContext({
      url: "https://docs.example.com/x",
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        const htmlPath = args.find((arg) => arg.endsWith(".html")) ?? "";
        existedDuringCall = await pathExists(htmlPath);
        return longMarkdown;
      },
    });

    const result = await renderHtmlToMarkdown(context, "trafilatura");
    expect(result?.method).toBe("trafilatura");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("trafilatura");
    expect(calls[0].args).not.toContain("-u");
    expect(calls[0].args.join(" ")).not.toContain("docs.example.com");
    const tempPath = calls[0].args.find((arg) => arg.endsWith(".html"))!;
    expect(tempPath).toBeTruthy();
    expect(existedDuringCall).toBe(true);
    expect(await pathExists(tempPath)).toBe(false);
  });

  test("lynx reads only a local temp file, never the URL", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const context = makeContext({
      commandRunner: async (command, args) => {
        commands.push({ command, args });
        return "lynx rendered text long enough to pass the usability heuristics ".repeat(20);
      },
    });

    const result = await renderHtmlToMarkdown(context, "lynx");
    expect(result?.method).toBe("lynx");
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("lynx");
    expect(commands[0].args.join(" ")).not.toContain("docs.example.com");
    expect(commands[0].args.some((arg) => arg.endsWith(".html"))).toBe(true);
  });
});
