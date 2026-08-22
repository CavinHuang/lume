import { describe, expect, test } from "bun:test";
import { buildMcpToolName, MAX_MCP_TOOL_NAME_LENGTH } from "./naming.js";

describe("MCP tool-name assembly (#326)", () => {
  test("normalizes illegal characters and case in both namespaces", () => {
    expect(buildMcpToolName("My Server", "Search.Issues!")).toBe("mcp__my-server__search_issues");
    expect(buildMcpToolName("", "")).toBe("mcp__server__tool");
    expect(buildMcpToolName("--weird--", "__tool__")).toBe("mcp__weird__tool");
  });

  test("clamps oversized identities to the provider-safe length with a hash suffix", () => {
    const longServer = "s".repeat(120);
    const longTool = "t".repeat(120);
    const name = buildMcpToolName(longServer, longTool);
    expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
    // The clamp eats into the joined name and appends a hash suffix.
    expect(name).toMatch(/^mcp__[a-z0-9_-]+_[a-z0-9]{6}$/);

    // Deterministic, and distinct identities that truncate to the same prefix
    // must not collide.
    const repeat = buildMcpToolName(longServer, longTool);
    expect(repeat).toBe(name);
    const other = buildMcpToolName(longServer, "u".repeat(120));
    expect(other).not.toBe(name);
    expect(other.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });
});
