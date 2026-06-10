import { describe, expect, test } from "bun:test";
import { adaptCodexPlugin, CODEX_EVENT_MAP } from "./codex-adapter.js";

describe("CodexAdapter", () => {
  test("maps Codex manifest fields to Lume manifest", () => {
    const codex = {
      name: "linear",
      version: "1.2.0",
      description: "Linear integration",
      author: "OpenAI",
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
      mcpServers: "./mcp.json",
      interface: {
        displayName: "Linear",
        category: "Productivity",
      },
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.schema).toBe("lume-plugin/v1");
    expect(result.name).toBe("linear");
    expect(result.version).toBe("1.2.0");
    expect(result.displayName).toBe("Linear");
    expect(result.category).toBe("Productivity");
    expect(result.skills).toEqual(["./skills/"]);
    expect(result.hooks).toBe("./hooks/hooks.json");
    expect(result.mcpServers).toBe("./mcp.json");
  });

  test("infers Codex-compatible permissions", () => {
    const codex = {
      name: "linear",
      version: "1.0.0",
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
      mcpServers: "./mcp.json",
      interface: {},
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.permissions.mcpServers.register).toBe(true);
    expect(result.permissions.shell.allow).toBe(true);
    expect(result.permissions.tools.deny).toContain("Bash");
    expect(result.permissions.tools.deny).toContain("FileWrite");
    expect(result.permissions.tools.allow).toContain("FileRead");
    expect(result.permissions.tools.allow).toContain("Glob");
    expect(result.lume.hooksOnly).toBe(false);
  });

  test("maps Codex hooks events to Lume equivalents", () => {
    const codex = {
      name: "test",
      version: "1.0.0",
      hooks: "./hooks/hooks.json",
      interface: {},
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.permissions.hooks?.events).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
  });

  test("throws on path with parent traversal", () => {
    const codex = {
      name: "test",
      version: "1.0.0",
      skills: "./skills/../etc/passwd",
      interface: {},
    };

    expect(() => adaptCodexPlugin(codex, "/plugin/root")).toThrow();
  });

  test("handles missing optional fields gracefully", () => {
    const codex = {
      name: "minimal",
      version: "0.1.0",
      interface: {},
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.skills).toBeUndefined();
    expect(result.hooks).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
    expect(result.permissions.mcpServers.register).toBe(true);
    expect(result.permissions.shell.allow).toBe(true);
  });

  test("CODEX_EVENT_MAP contains all 10 events", () => {
    expect(Object.keys(CODEX_EVENT_MAP)).toHaveLength(10);
    expect(CODEX_EVENT_MAP["PreToolUse"]).toBe("PreToolUse");
    expect(CODEX_EVENT_MAP["Stop"]).toBe("Stop");
  });
});
