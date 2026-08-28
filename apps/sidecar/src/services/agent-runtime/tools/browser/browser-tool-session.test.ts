import { describe, expect, test } from "bun:test";
import type { BrowserTabDescriptor } from "@lume/shared";
import { BrowserToolSessionRegistry } from "./browser-tool-session";

function agentTab(tabId: string): BrowserTabDescriptor {
  return {
    tabId,
    ownerThreadId: "thread-1",
    profileKind: "agent",
    backend: "iab",
    generation: 1,
    url: "https://example.com",
    title: tabId,
    visible: false,
    surface: null,
  };
}

describe("BrowserToolSessionRegistry tabsCache 失效（#838②）", () => {
  test("invalidateTabsCacheByTab 只清包含该 tab 的会话缓存", () => {
    const registry = new BrowserToolSessionRegistry();
    const a = registry.getOrCreate("thread-a");
    const b = registry.getOrCreate("thread-b");
    a.tabsCache = { tabs: [agentTab("keep-1"), agentTab("dead-1")], fetchedAt: Date.now() };
    b.tabsCache = { tabs: [agentTab("keep-2")], fetchedAt: Date.now() };

    const cleared = registry.invalidateTabsCacheByTab("dead-1");

    expect(cleared).toBe(1);
    expect(a.tabsCache).toBeUndefined();
    expect(b.tabsCache).toBeDefined();
  });

  test("未命中任何缓存时返回 0 且不误清", () => {
    const registry = new BrowserToolSessionRegistry();
    const a = registry.getOrCreate("thread-a");
    a.tabsCache = { tabs: [agentTab("alive")], fetchedAt: Date.now() };

    expect(registry.invalidateTabsCacheByTab("ghost")).toBe(0);
    expect(a.tabsCache).toBeDefined();
  });
});
