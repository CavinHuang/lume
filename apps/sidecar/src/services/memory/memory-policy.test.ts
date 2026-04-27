import { describe, expect, test } from "bun:test";
import {
  applyMemoryToolPolicy,
  deriveChatTypeFromThreadKey,
  deriveChatTypeFromThreadType,
  normalizeMemoryChatType,
  parseMemoryRuntimeConfigPayload,
  shouldIncludeCitations
} from "./memory-policy";

describe("memory-policy", () => {
  test("group:memory allow 仅保留 search/get", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: { allow: ["group:memory"] }
    });
    expect(result).toEqual(["memory.search", "memory.read"]);
  });

  test("deny 可覆盖 allow", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: { allow: ["group:memory", "memory_save"], deny: ["memory_get"] }
    });
    expect(result).toEqual(["memory.search", "memory.remember"]);
  });

  test("allow=* 时应允许全部基础工具（再应用 deny）", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: { allow: ["*"], deny: ["memory_get"] }
    });
    expect(result).toEqual(["memory.search", "memory.remember"]);
  });

  test("allow 支持通配符", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: { allow: ["memory_*"] }
    });
    expect(result).toEqual(["memory.search", "memory.read", "memory.remember"]);
  });

  test("deny 支持通配符，且优先于 allow", () => {
    const result = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: { allow: ["memory_*"], deny: ["*_save"] }
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
      tools: { allow: ["group:memory", "memory_save"], deny: ["memory_get"] },
      sources: ["memory", "sessions"],
      extraPaths: ["/data/memory", " docs/memory "]
    });
    expect(result.citationsMode).toBe("on");
    expect(result.toolPolicy?.allow).toEqual(["group:memory", "memory_save"]);
    expect(result.toolPolicy?.deny).toEqual(["memory_get"]);
    expect(result.sources).toEqual(["memory", "sessions"]);
    expect(result.extraPaths).toEqual(["/data/memory", "docs/memory"]);
  });

  test("parseMemoryRuntimeConfigPayload 非法内容回退默认", () => {
    const result = parseMemoryRuntimeConfigPayload({
      version: 1,
      citations: "bad",
      tools: { allow: [123, "memory_get"], deny: ["memory_search", null] }
    });
    expect(result.citationsMode).toBe("auto");
    expect(result.toolPolicy?.allow).toEqual(["memory_get"]);
    expect(result.toolPolicy?.deny).toEqual(["memory_search"]);
    expect(result.sources).toEqual(["memory"]);
    expect(result.extraPaths).toEqual([]);
  });

  test("默认配置应仅开放 group:memory（不含 memory_save）", () => {
    const result = parseMemoryRuntimeConfigPayload({ version: 1 });
    const tools = applyMemoryToolPolicy({
      baseTools: ["memory_search", "memory_get", "memory_save"],
      policy: result.toolPolicy
    });
    expect(tools).toEqual(["memory.search", "memory.read"]);
    expect(result.sources).toEqual(["memory"]);
    expect(result.extraPaths).toEqual([]);
  });
});
