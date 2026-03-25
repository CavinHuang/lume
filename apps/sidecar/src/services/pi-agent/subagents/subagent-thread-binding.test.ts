import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession } from "../../agent/agent-session-manager";
import { resolveSubagentThreadBinding } from "./subagent-thread-binding";

describe("subagent-thread-binding", () => {
  test("应在请求 thread 时标记 threadBound 并解析 delivery session", () => {
    const prev = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-subagent-thread-"));
    try {
      const parent = createAgentSession("父会话");
      const inbox = createAgentSession("收件会话");
      const resolved = resolveSubagentThreadBinding({
        parentSessionId: parent.id,
        childSessionId: "child-x",
        threadRequested: true,
        requestedDeliverySessionId: inbox.id
      });
      expect(resolved.threadRequested).toBe(true);
      expect(resolved.threadBound).toBe(true);
      expect(resolved.deliverySessionId).toBe(inbox.id);
    } finally {
      if (prev === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = prev;
      }
    }
  });

  test("delivery session 不存在时应回退到 parent session", () => {
    const resolved = resolveSubagentThreadBinding({
      parentSessionId: "parent-a",
      childSessionId: "child-a",
      threadRequested: false,
      requestedDeliverySessionId: "missing-session"
    });
    expect(resolved.deliverySessionId).toBe("parent-a");
    expect(resolved.threadBound).toBe(false);
  });
});
