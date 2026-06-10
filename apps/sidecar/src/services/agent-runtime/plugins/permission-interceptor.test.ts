import { describe, expect, test } from "bun:test";
import { createPluginPermissionInterceptor } from "./permission-interceptor.js";

describe("createPluginPermissionInterceptor", () => {
  test("denies tool when plugin tools.deny matches", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { deny: ["Bash", "FileWrite"] },
      },
    });

    const result = await interceptor({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("demo");
  });

  test("allows tool when plugin tools.allow matches", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { allow: ["FileRead", "Glob"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/data/notes.md" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("allow");
  });

  test("passes through unlisted tool to global engine", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { allow: ["FileRead"] },
      },
    });

    const result = await interceptor({
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      context: { cwd: "/project", threadId: "t1" },
    });

    // Not in any list → pass through to global permission engine
    expect(result).toBeUndefined();
  });

  test("asks when path outside filesystem.read pattern", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        filesystem: { read: ["./data/**"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/secret.json" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("ask");
  });

  test("allows path within filesystem.read pattern", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        filesystem: { read: ["./data/**"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/data/config.json" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("allow");
  });

  test("asks for network host not in outbound list", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        network: { outbound: ["api.example.com"] },
      },
    });

    const result = await interceptor({
      toolName: "WebFetch",
      input: { url: "https://evil.com" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("ask");
  });

  test("passes through when no permissions defined", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {},
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/any/path" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result).toBeUndefined();
  });
});
