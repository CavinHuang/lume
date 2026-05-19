import { describe, expect, test } from "bun:test";
import {
  applyMemoryToolPolicy,
  deriveChatTypeFromThreadKey,
  deriveChatTypeFromThreadType,
  getMemoryRuntimeConfig,
  normalizeMemoryChatType,
  parseMemoryRuntimeConfigPayload,
  shouldIncludeCitations,
  updateMemoryRuntimeConfig
} from "./memory-policy";

describe("memory-policy", () => {
  test("group:memory allow 仅保留 search/get", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: { allow: ["group:memory"] }
    });
    expect(result).toEqual(["memory.search", "memory.read"]);
  });

  test("旧维护和全局分组不再展开为可用工具", () => {
    const result = applyMemoryToolPolicy({
      baseTools: [
        "memory.search",
        "memory.read",
        "memory.remember",
        "memory.distillWorkspace",
        "memory.searchGlobal",
        "memory.promoteGlobal"
      ],
      policy: {
        allow: ["group:memory-maintenance", "group:memory-global", "group:memory-global-write", "group:memory-write"]
      }
    });
    expect(result).toEqual(["memory.remember"]);
  });

  test("deny 可覆盖 allow", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: { allow: ["group:memory", "memory.remember"], deny: ["memory.read"] }
    });
    expect(result).toEqual(["memory.search", "memory.remember"]);
  });

  test("allow=* 时应允许全部基础工具（再应用 deny）", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: { allow: ["*"], deny: ["memory.read"] }
    });
    expect(result).toEqual(["memory.search", "memory.remember"]);
  });

  test("allow 支持通配符", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: { allow: ["memory.*"] }
    });
    expect(result).toEqual(["memory.search", "memory.read", "memory.remember"]);
  });

  test("deny 支持通配符，且优先于 allow", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: { allow: ["memory.*"], deny: ["memory.remember"] }
    });
    expect(result).toEqual(["memory.search", "memory.read"]);
  });

  test("citation auto 仅 direct 为 true", () => {
    expect(shouldIncludeCitations("auto", "direct")).toBe(true);
    expect(shouldIncludeCitations("auto", "group")).toBe(false);
    expect(shouldIncludeCitations("auto", "channel")).toBe(false);
  });

  test("从 session key 解析 chat type", () => {
    expect(deriveChatTypeFromThreadKey("agent:main:discord:group:c123")).toBe("group");
    expect(deriveChatTypeFromThreadKey("agent:main:slack:channel:c123")).toBe("channel");
    expect(deriveChatTypeFromThreadKey("thread-uuid")).toBe("direct");
  });

  test("从 threadType 解析 chat type", () => {
    expect(deriveChatTypeFromThreadType("main")).toBe("direct");
    expect(deriveChatTypeFromThreadType("subagent")).toBe("direct");
    expect(deriveChatTypeFromThreadType("group")).toBe("group");
    expect(deriveChatTypeFromThreadType("channel")).toBe("channel");
    expect(deriveChatTypeFromThreadType("other")).toBeUndefined();
  });

  test("normalizeMemoryChatType 仅接受 direct/group/channel", () => {
    expect(normalizeMemoryChatType("direct")).toBe("direct");
    expect(normalizeMemoryChatType("group")).toBe("group");
    expect(normalizeMemoryChatType("channel")).toBe("channel");
    expect(normalizeMemoryChatType("other")).toBeUndefined();
  });

  test("parseMemoryRuntimeConfigPayload 应兼容无 version 旧格式", () => {
    const result = parseMemoryRuntimeConfigPayload({
      citations: "on",
      tools: { allow: ["group:memory", "memory.remember"], deny: ["memory.read"] },
      sources: ["memory", "sessions"],
      extraPaths: ["/data/memory", " docs/memory "]
    });
    expect(result.citationsMode).toBe("on");
    expect(result.toolPolicy?.allow).toEqual(["group:memory", "memory.remember"]);
    expect(result.toolPolicy?.deny).toEqual(["memory.read"]);
    expect(result.sources).toEqual(["memory", "sessions"]);
    expect(result.extraPaths).toEqual(["/data/memory", "docs/memory"]);
  });

  test("parseMemoryRuntimeConfigPayload 非法内容回退默认", () => {
    const result = parseMemoryRuntimeConfigPayload({
      version: 1,
      citations: "bad",
      tools: { allow: [123, "memory.read"], deny: ["memory.search", null] }
    });
    expect(result.citationsMode).toBe("auto");
    expect(result.toolPolicy?.allow).toEqual(["memory.read"]);
    expect(result.toolPolicy?.deny).toEqual(["memory.search"]);
    expect(result.sources).toEqual(["memory"]);
    expect(result.extraPaths).toEqual([]);
  });

  test("默认配置应仅开放 group:memory（不含写入工具）", () => {
    const result = parseMemoryRuntimeConfigPayload({ version: 1 });
    const tools = applyMemoryToolPolicy({
      baseTools: ["memory.search", "memory.read", "memory.remember"],
      policy: result.toolPolicy
    });
    expect(tools).toEqual(["memory.search", "memory.read"]);
    expect(result.sources).toEqual(["memory"]);
    expect(result.extraPaths).toEqual([]);
  });

  test("updateMemoryRuntimeConfig 应持久化记忆工具分组权限", () => {
    const saved = updateMemoryRuntimeConfig({
      tools: {
        allow: ["group:memory", "group:memory-write"],
        deny: ["memory.read"]
      },
      citations: "on",
      sources: ["memory", "sessions"]
    });

    expect(saved.tools.allow).toEqual(["group:memory", "group:memory-write"]);
    expect(saved.tools.deny).toEqual(["memory.read"]);
    expect(saved.citations).toBe("on");
    expect(saved.sources).toEqual(["memory", "sessions"]);
    expect(getMemoryRuntimeConfig()).toEqual(saved);
  });
});
