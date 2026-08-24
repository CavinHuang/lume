import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageAppendedEvent } from "@lume/shared";
import { createImAgentStreamEmitter } from "./im-message-router";
import { createImAccount } from "./im-config-manager";
import { upsertImThreadBinding } from "./im-thread-binding-store";
import {
  createImRunCardSession,
  setImRunCardSessionFactoryForTest,
  type ImRunCardSession
} from "./im-run-card-session";

function fakeSession(options: { openOk: boolean; events: unknown[]; finished: unknown[] }): ImRunCardSession {
  return {
    handleEvent: (event) => {
      options.events.push(event);
    },
    finish: (status) => {
      options.finished.push(status);
    },
    isEnabled: () => true,
    settleOpen: () => Promise.resolve(options.openOk)
  };
}

function assistantAppendEvent(text: string): AgentMessageAppendedEvent {
  return {
    message: {
      id: "am1",
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString()
    }
  } as unknown as AgentMessageAppendedEvent;
}

describe("createImAgentStreamEmitter × 流式卡片通道", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-card-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    setImRunCardSessionFactoryForTest(null);
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("卡片可用时 assistant 回复不重复走文本投递，终态触发 finish", async () => {
    const events: unknown[] = [];
    const finished: unknown[] = [];
    setImRunCardSessionFactoryForTest(() => fakeSession({ openOk: true, events, finished }));

    const sentTexts: string[] = [];
    const emitter = createImAgentStreamEmitter("thread-1", {
      sendBoundTextMessage: async (input) => {
        sentTexts.push(input.text);
        return { ok: true };
      }
    });
    emitter.onMessageAppended?.(assistantAppendEvent("卡片已承载的内容"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentTexts).toEqual([]);

    emitter.onComplete(undefined);
    expect(finished.length).toBe(1);
    expect((finished[0] as { kind: string }).kind).toBe("completed");
  });

  test("开卡失败时回退文本投递", async () => {
    const events: unknown[] = [];
    const finished: unknown[] = [];
    setImRunCardSessionFactoryForTest(() => fakeSession({ openOk: false, events, finished }));

    // 文本回退路径需要真实 binding
    const account = await createImAccount({
      provider: "feishu",
      label: "飞书测试",
      accountKey: "cli_test",
      token: "secret",
      enabled: true
    });
    upsertImThreadBinding({
      provider: "feishu",
      accountId: account.id,
      peerKind: "dm",
      peerId: "oc_fallback",
      threadId: "thread-2"
    });

    const sentTexts: string[] = [];
    const emitter = createImAgentStreamEmitter("thread-2", {
      sendBoundTextMessage: async (input) => {
        sentTexts.push(input.text);
        return { ok: true };
      }
    });
    emitter.onMessageAppended?.(assistantAppendEvent("降级文本回复"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentTexts).toEqual(["降级文本回复"]);
  });

  test("onError 触发 failed 终态并转发运行时事件到卡片", () => {
    const events: unknown[] = [];
    const finished: unknown[] = [];
    setImRunCardSessionFactoryForTest(() => fakeSession({ openOk: false, events, finished }));

    const emitter = createImAgentStreamEmitter("thread-3", {
      sendBoundTextMessage: async () => ({ ok: true })
    });
    emitter.onError?.("炸了");
    expect(finished).toEqual([{ kind: "failed", error: "炸了" }]);
  });

  test("无注入时工厂按 binding 渠道判定：非飞书返回 null", () => {
    setImRunCardSessionFactoryForTest(null);
    // thread 未绑定任何 IM 会话 → null（不建卡）
    expect(createImRunCardSession("no-such-thread")).toBeNull();
  });
});
