import { describe, expect, test } from "bun:test";
import { matchesToolPattern } from "./tool-approval";

test("matches Alice-style lowercase tool aliases to SDK tool names", () => {
  expect(matchesToolPattern("Read", "read_file")).toBe(true);
  expect(matchesToolPattern("Bash", "bash")).toBe(true);
  expect(matchesToolPattern("Glob", "glob")).toBe(true);
  expect(matchesToolPattern("Grep", "grep")).toBe(true);
  expect(matchesToolPattern("WebSearch", "web_search")).toBe(true);
  expect(matchesToolPattern("ListMcpResourcesTool", "list_mcp_resources")).toBe(true);
});

test("matches Alice directory listing aliases to SDK and desktop tools", () => {
  expect(matchesToolPattern("Glob", "list_dir")).toBe(true);
  expect(matchesToolPattern("ls", "list_dir")).toBe(true);
  expect(matchesToolPattern("ls", "list_directory")).toBe(true);
});

test("keeps existing exact and prefix pattern behavior", () => {
  expect(matchesToolPattern("mcp__server__lookup", "mcp__server__*")).toBe(true);
  expect(matchesToolPattern("Write", "Read")).toBe(false);
});

describe("#379 case-insensitive matching", () => {
  test("wildcard prefix match ignores casing without alias-normalizing the prefix", () => {
    expect(matchesToolPattern("mcp__GitHub__Create_Issue", "mcp__github__*")).toBe(true);
    expect(matchesToolPattern("MCP__GITHUB__LOOKUP", "mcp__github__*")).toBe(true);
    // The mcp__ structure survives: an unrelated server prefix must not match.
    expect(matchesToolPattern("mcp__other__Create_Issue", "mcp__github__*")).toBe(false);
  });

  test("unknown MCP-style exact names match regardless of casing", () => {
    expect(matchesToolPattern("mcp__Server__Tool", "mcp__server__tool")).toBe(true);
    expect(matchesToolPattern("mcp__server__tool", "MCP__SERVER__TOOL")).toBe(true);
    expect(matchesToolPattern("mcp__server__tool", "mcp__server__other")).toBe(false);
  });

  test("known tool aliases stay case-insensitive in both directions", () => {
    expect(matchesToolPattern("BASH", "Bash")).toBe(true);
    expect(matchesToolPattern("Bash", "BASH")).toBe(true);
  });
});
