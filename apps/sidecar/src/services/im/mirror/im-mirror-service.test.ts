import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeRuntimeEvent } from "@lume/shared";
import { createImAccount, recordImDmInteraction } from "../im-config-manager";
import {
  getImMirrorEntryByThreadId,
  getImMirrorSettings,
  setMirrorOwnerAccountId,
  upsertImMirrorEntry
} from "../im-mirror-store";
import { upsertImThreadBinding } from "../im-thread-binding-store";
import { registerImProvider, type ImProviderDefinition } from "../provider-registry";
import { setImRunCardStreamFactoryForTest } from "../im-run-card-session";
import type { FeishuCardStream } from "../feishu/feishu-card-stream";
import {
  dissolveMirrorForThread,
  subscribeImMirrorStreamActivity,
  syncMirrorGroupNameFromMeta,
  wrapAgentEmitterForMirror
} from "./im-mirror-service";
import { getAgentSessionsIndexPath } from "../../infra/config-paths";

// ---------------------------------------------------------------------------
// 测试策略：LUME_CONFIG_DIR 重定向到临时目录；线程索引直写 agent-sessions.json
// （index 缓存按 mtime+size 失效）；provider 注册表注入伪 feishu 定义，配合
// setImRunCardSessionFactoryForTest 拦截卡片流构造——全场景零真实网络。
// ---------------------------------------------------------------------------

let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-mirror-service-test-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  setImRunCardStreamFactoryForTest(null);
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

function writeThreadFixture(threadId: string, title: string, status?: string): void {
  mkdirSync(tempConfigDir, { recursive: true });
  writeFileSync(
    getAgentSessionsIndexPath(),
    JSON.stringify({
      version: 1,
      threads: [
        {
          id: threadId,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(status ? { status } : {})
        }
      ]
    }),
    "utf-8"
  );
}

function seedOwnerAccount(input: { senderId?: string }): string {
  const account = createImAccount({
    provider: "feishu",
    label: "镜像承担",
    token: "app-secret",
    accountKey: "cli_app",
    enabled: true
  });
  if (input.senderId) recordImDmInteraction(account.id, input.senderId);
  setMirrorOwnerAccountId(account.id);
  return account.id;
}

interface MirrorSpies {
  createdGroups: Array<{ name: string; userOpenId?: string }>;
  renamed: Array<{ chatId: string; name: string }>;
  leftChats: string[];
}

function registerFakeFeishu(input: { createGroupOk?: boolean; leaveGroupThrows?: boolean } = {}): MirrorSpies {
  const createdGroups: Array<{ name: string; userOpenId?: string }> = [];
  const renamed: Array<{ chatId: string; name: string }> = [];
  const leftChats: string[] = [];
  const def: ImProviderDefinition = {
    provider: "feishu",
    createWorker: () => ({ start() {}, stop() {}, isRunning: () => false }),
    sendText: async () => ({ ok: true }),
    mirror: {
      carrier: "card",
      createGroup: async ({ name, userOpenId }) => {
        createdGroups.push({ name, userOpenId });
        if (input.createGroupOk === false) {
          return { ok: false, error: "forbidden(code 99991672)" };
        }
        return { ok: true, chatId: `oc_mirror_${createdGroups.length}` };
      },
      renameGroup: async ({ chatId, name }) => {
        renamed.push({ chatId, name });
        return { ok: true };
      },
      leaveGroup: async ({ chatId }) => {
        if (input.leaveGroupThrows) throw new Error("network down");
        leftChats.push(chatId);
        return { ok: true };
      }
    }
  };
  registerImProvider(def);
  return { createdGroups, renamed, leftChats };
}

interface HostEmit {
  onRuntimeEvent(event: LumeRuntimeEvent): void;
  onComplete(payload?: { reason?: "max_turns" | "repeat_guard" | "stopped" }): void;
  onError(error: string): void;
}

function makeHostEmitter(): { emit: HostEmit; passthroughCount: { complete: number } } {
  let passed = 0;
  return {
    emit: {
      onRuntimeEvent: () => {},
      onComplete: () => {
        passed += 1;
      },
      onError: () => {}
    },
    passthroughCount: {
      get complete() {
        return passed;
      }
    }
  };
}

function triggerEvent(threadId: string): LumeRuntimeEvent {
  return {
    id: `e_${Math.random().toString(36).slice(2)}`,
    type: "assistant.delta",
    threadId,
    runId: "",
    createdAt: new Date().toISOString(),
    delta: "你好"
  } as LumeRuntimeEvent;
}

/**
 * 拦截卡片流构造（服务经 buildImRunCardSession 直达流级，故注入 stream 工厂而非
 * createImRunCardSession 的会话工厂）。返回的 records 与会话级事件/终态一一对应。
 */
function installFakeCardStream(): {
  builtSessions: Array<{ events: LumeRuntimeEvent[]; finished: unknown }>;
} {
  const builtSessions: Array<{ events: LumeRuntimeEvent[]; finished: unknown }> = [];
  setImRunCardStreamFactoryForTest((options) => {
    const record: { events: LumeRuntimeEvent[]; finished: unknown } = { events: [], finished: null };
    builtSessions.push(record);
    void options;
    const stream = {
      open: async () => true,
      apply: (event: LumeRuntimeEvent) => {
        record.events.push(event);
      },
      state: { blocks: [] as unknown[], status: "running", degraded: false },
      degraded: false,
      close: () => {}
    } as unknown as FeishuCardStream;
    return stream;
  });
  return { builtSessions };
}

async function until(condition: () => boolean, ms = 1500, debug?: () => string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > ms) {
      if (debug) {
        // bun 会去重重复 stderr 行，且 afterEach 会删临时目录——转储写到固定路径
        appendFileSync(join(tmpdir(), "lume-mirror-dump.log"), `${debug()}\n`, "utf-8");
      }
      throw new Error("等待超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("im-mirror-service wrapAgentEmitterForMirror", () => {
  test("off/未选承担账号：wrap 原引用直返（零行为变化）", () => {
    expect(getImMirrorSettings().enabledMirrorAccountId).toBeNull();
    const { emit } = makeHostEmitter();
    expect(wrapAgentEmitterForMirror("thr_x", emit)).toBe(emit);
  });

  test("origin 以 im. 开头：永不镜像（守卫二，即使其余条件齐备）", () => {
    writeThreadFixture("thr_im", "IM 线程");
    seedOwnerAccount({ senderId: "ou_t" });
    registerFakeFeishu();
    const { emit } = makeHostEmitter();
    expect(wrapAgentEmitterForMirror("thr_im", emit, "im.feishu")).toBe(emit);
  });

  test("线程存在 DM 绑定：拒绝上镜（守卫一，结构性自环不变量）", () => {
    writeThreadFixture("thr_dm", "被绑定的 IM 线程");
    seedOwnerAccount({ senderId: "ou_t" });
    registerFakeFeishu();
    upsertImThreadBinding({
      provider: "feishu",
      accountId: "acc-other",
      peerKind: "dm",
      peerId: "ou_someone",
      threadId: "thr_dm"
    });
    const { emit } = makeHostEmitter();
    expect(wrapAgentEmitterForMirror("thr_dm", emit)).toBe(emit);
  });

  test("线程缺失或非活跃（trashed）：原引用直返", () => {
    seedOwnerAccount({ senderId: "ou_t" });
    registerFakeFeishu();
    const a = makeHostEmitter().emit;
    const b = makeHostEmitter().emit;
    // 线程不存在于索引
    expect(wrapAgentEmitterForMirror("thr_missing", a)).toBe(a);
    // 回收站态
    writeThreadFixture("thr_dead", "回收站线程", "trashed");
    expect(wrapAgentEmitterForMirror("thr_dead", b)).toBe(b);
  });

  test("无 lastInteractedSenderId：建群前拦截并写中文指引文案", async () => {
    writeThreadFixture("thr_nouser", "任务");
    seedOwnerAccount({});
    registerFakeFeishu();
    const { builtSessions } = installFakeCardStream();

    const { emit } = makeHostEmitter();
    const wrapped = wrapAgentEmitterForMirror("thr_nouser", emit);
    expect(wrapped).not.toBe(emit);
    wrapped.onRuntimeEvent(triggerEvent("thr_nouser"));
    await until(() => getImMirrorSettings().lastError !== undefined);

    expect(getImMirrorSettings().lastError).toContain("私聊");
    expect(builtSessions).toHaveLength(0);
  });

  test("建群权限码失败：静默降级且错误映射为权限指引文案", async () => {
    writeThreadFixture("thr_deny", "任务");
    seedOwnerAccount({ senderId: "ou_target" });
    registerFakeFeishu({ createGroupOk: false });

    const { emit } = makeHostEmitter();
    const wrapped = wrapAgentEmitterForMirror("thr_deny", emit);
    wrapped.onRuntimeEvent(triggerEvent("thr_deny"));
    await until(() => getImMirrorSettings().lastError !== undefined);

    expect(getImMirrorSettings().lastError).toContain("缺少 im:chat");
  });

  test("端到端成功链：目标用户入群、缓冲事件按序投喂一次、保活通知开合、完成透传", async () => {
    writeThreadFixture("thr_ok", "要镜像的任务");
    seedOwnerAccount({ senderId: "ou_target" });
    const fake = registerFakeFeishu();
    const { builtSessions } = installFakeCardStream();
    const activity: boolean[] = [];
    const unsubscribe = subscribeImMirrorStreamActivity((a) => activity.push(a.active));

    const { emit, passthroughCount } = makeHostEmitter();
    const wrapped = wrapAgentEmitterForMirror("thr_ok", emit);
    expect(wrapped).not.toBe(emit);

    // 就绪前事件全部进 buffer；就绪后一次性按序投喂、不重不漏
    wrapped.onRuntimeEvent(triggerEvent("thr_ok"));
    wrapped.onRuntimeEvent(triggerEvent("thr_ok"));
    await until(
      () => activity.length === 1 && activity[0] === true,
      1500,
      () =>
        `activity=${JSON.stringify(activity)} sessions=${builtSessions.length} evs=${
          builtSessions[0]?.events.length ?? "-"
        } groups=${fake.createdGroups.length} ownerErr=${getImMirrorSettings().lastError ?? "-"}`
    );

    wrapped.onComplete(undefined);
    await until(() =>
      builtSessions.length === 1 && builtSessions[0]!.events.some((e) => e.type === "run.completed")
    );

    expect(fake.createdGroups[0]).toEqual({ name: "要镜像的任务", userOpenId: "ou_target" });
    // 缓冲的两条事件 + reducer 终态事件全部抵达底层卡片流
    expect(builtSessions[0]!.events.length).toBeGreaterThanOrEqual(2);
    expect(builtSessions[0]!.events.some((e) => e.type === "run.completed")).toBe(true);
    // 完成钩子仍透传原 emitter（桌面行为不变）
    expect(passthroughCount.complete).toBe(1);
    expect(activity).toEqual([true, false]);
    unsubscribe();
  });

  test("onError 走 failed 终态并携带错误串", async () => {
    writeThreadFixture("thr_err", "会失败的任务");
    seedOwnerAccount({ senderId: "ou_target" });
    registerFakeFeishu();
    const { builtSessions } = installFakeCardStream();

    const { emit } = makeHostEmitter();
    const wrapped = wrapAgentEmitterForMirror("thr_err", emit);
    wrapped.onRuntimeEvent(triggerEvent("thr_err"));
    // 建群链就绪前就终结的 run 按「不镜像」处理（v1 语义：惰性首跑天然重试）
    await until(() => builtSessions.length === 1 && builtSessions[0]!.events.length > 0);
    wrapped.onError("boom");
    await until(() =>
      builtSessions[0]!.events.some((e) => e.type === "run.failed")
    );

    const failed = builtSessions[0]!.events.find((e) => e.type === "run.failed") as
      | { error?: { message?: string } }
      | undefined;
    expect(failed?.error?.message).toBe("boom");
  });
});

describe("im-mirror-service 群生命周期联动", () => {
  test("标题变化同步群名一次；同标题幂等跳过", async () => {
    const account = createImAccount({
      provider: "feishu",
      label: "同步用",
      token: "s",
      accountKey: "cli_s",
      enabled: true
    });
    upsertImMirrorEntry({ threadId: "thr_sync2", accountId: account.id, chatId: "oc_2", carrier: "card" });
    const fake = registerFakeFeishu();

    await syncMirrorGroupNameFromMeta("thr_sync2", " 新标题 ");
    await syncMirrorGroupNameFromMeta("thr_sync2", "新标题");
    expect(fake.renamed).toEqual([{ chatId: "oc_2", name: "新标题" }]);
  });

  test("删除联动：leaveGroup 抛错仍清映射；无映射二次调用安全", async () => {
    const account = createImAccount({
      provider: "feishu",
      label: "退群用",
      token: "s",
      accountKey: "cli_leave",
      enabled: true
    });
    upsertImMirrorEntry({ threadId: "thr_gone", accountId: account.id, chatId: "oc_gone", carrier: "text" });
    registerFakeFeishu({ leaveGroupThrows: true });

    await dissolveMirrorForThread("thr_gone");
    expect(getImMirrorEntryByThreadId("thr_gone")).toBeNull();
    // 无映射再删不抛不出错（leaveGroup 未被调用）
    await dissolveMirrorForThread("thr_unknown_thread");
  });
});
