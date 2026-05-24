import { expect, test } from "bun:test";
import {
  buildMcpToolWrapperName,
  maskMcpSecrets,
  normalizeMcpServerId,
  normalizeMcpTransport,
  parseMcpImportPayload
} from "./mcp";

test("normalizes legacy http to streamable_http", () => {
  expect(normalizeMcpTransport({ type: "http" })).toBe("streamable_http");
  expect(normalizeMcpTransport({ transport: "streamable_http" })).toBe("streamable_http");
});

test("keeps server id stable and independent from display name", () => {
  expect(normalizeMcpServerId("GitHub MCP")).toBe("github-mcp");
  expect(normalizeMcpServerId("")).toBeNull();
});

test("builds stable MCP wrapper names", () => {
  expect(buildMcpToolWrapperName("github-mcp", "search/issues")).toMatch(/^mcp__github-mcp__search_issues/);
});

test("adds deterministic suffixes for canonical tool name collisions", () => {
  const first = buildMcpToolWrapperName("github-mcp", "search/issues");
  const second = buildMcpToolWrapperName("github-mcp", "search issues", new Set([first]));
  expect(second).toMatch(/^mcp__github-mcp__search_issues_[a-z0-9]{6}$/);
  expect(buildMcpToolWrapperName("github-mcp", "search issues", new Set([first]))).toBe(second);
});

test("parses standard mcpServers import payload", () => {
  const parsed = parseMcpImportPayload({
    mcpServers: {
      alice: {
        url: "http://127.0.0.1:9000/mcp",
        headers: { Authorization: "Bearer token" }
      }
    }
  });
  expect(parsed.servers.alice?.transport).toBe("streamable_http");
  expect(parsed.servers.alice?.enabled).toBe(true);
});

test("parses direct import payload and defaults command entries to stdio", () => {
  const parsed = parseMcpImportPayload({
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  });
  expect(parsed.servers.filesystem?.transport).toBe("stdio");
  expect(parsed.servers.filesystem?.enabled).toBe(true);
});

test("masks secret headers and env values", () => {
  expect(maskMcpSecrets({ Authorization: "Bearer abc", DEBUG: "1" })).toEqual({
    Authorization: "********",
    DEBUG: "1"
  });
});
