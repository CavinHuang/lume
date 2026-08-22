import { expect, test } from "bun:test";
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
