/**
 * integration.test.ts — 建议系统端到端集成测试
 *
 * 目标：跑通 REAL signals → rules → engine → store → feedback 管线，仅在外部边界
 * 打桩（adapter / dedup 源 / memory-v2 写入 / automation 写入 / LLM analyst）。
 *
 * 验证两条关键链路：
 *  1) 用户含纠正语气的消息 → evaluateSessionSuggestions → correction 候选 →
 *     persistSuggestion → listSuggestions("suggested") 出现 status="suggested" 的
 *     correction 记录；注入的 broadcaster 被调用。
 *  2) handleSuggestionFeedback(id, "accepted") on memory_correction → 调用
 *     MemoryCommandService.remember（mock 捕获）AND feedback 层把 correction 类型权重
 *     从 1.0 调到 1.2（1.0 × 1.2）。
 *
 * 真实 vs 打桩：
 *  REAL：signals / rules / engine / feedback / store / service（编排逻辑本身）
 *  MOCK：
 *    - adapter.extractRecentConversation：返回固定含纠正语的消息数组（不打线程 transcript）
 *    - automation-manager：listAutomationJobs→[]（dedup 空）/ createAutomationJob→spy
 *    - memory-v2/markdown-store：listEntries/listPending→[]（dedup 空）
 *    - memory-v2/command-service：remember→spy（不写真实记忆）
 *    - analyst：buildAnalysisInput/runAnalysis→[]（LLM 链路在 analyst.test.ts 单独覆盖）
 *    - infra/logger：静默
 *
 * Store I/O 走 tmpdir + LUME_CONFIG_DIR（同 store.test.ts / feedback.test.ts 套路）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ===== 外部边界 spy =====
const spies = {
  /** adapter 调用计数（验证管线确实读取了会话消息） */
  extractCalls: mock((_input: unknown) => {}),
  /** MemoryCommandService.remember 捕获（accepted memory_correction 动作） */
  remember: mock(async (_input: Record<string, unknown>) => ({
    action: "created" as const,
  })),
  /** createAutomationJob 捕获（accepted open_automation_create 动作） */
  createAutomationJob: mock((input: { name: string; prompt: string; schedule: unknown }) => ({
    id: "job-1",
    ...input,
  })),
  /** IPC 建议变更广播器捕获 */
  broadcaster: mock(() => {}),
};

// ===== mock.module：仅外部边界 =====

// adapter：返回固定含纠正语的用户消息（绕开 thread transcript 读取）
mock.module("./adapter", () => ({
  extractRecentConversation: async (input: unknown) => {
    spies.extractCalls(input);
    return [{ role: "user", content: "以后不要用 var 声明变量" }];
  },
}));

// automation-manager：listAutomationJobs→[]（dedup 空）+ createAutomationJob→spy
const managerActual = await import("../automation/automation-manager");
mock.module("../automation/automation-manager", () => ({
  ...managerActual,
  listAutomationJobs: () => [],
  createAutomationJob: spies.createAutomationJob,
}));

// memory-v2/markdown-store：listEntries/listPending→[]（dedup 空，不打 memory 文件）
mock.module("../memory-v2/markdown-store", () => ({
  listEntries: () => [],
  listPending: () => [],
  readActivation: () => ({ recall: true, persona: true, suggestion: true, analyst: true }),
}));

// memory-v2/command-service：spy（accepted memory_correction 动作不写真实记忆）
mock.module("../memory-v2/command-service", () => ({
  MemoryCommandService: class MemoryCommandService {
    remember = spies.remember;
  },
}));

// analyst：LLM 链路不参与本集成测试（analyst.test.ts 已单独覆盖）
mock.module("./analyst", () => ({
  buildAnalysisInput: () => "",
  runAnalysis: async () => [],
}));

// infra/logger：静默
mock.module("../infra/logger", () => ({
  createLogger: () => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
}));

// ===== 在 mock 装配完成后，再 import 真实模块 =====
const {
  evaluateSessionSuggestions,
  handleSuggestionFeedback,
  setSuggestionChangeBroadcaster,
} = await import("./service");
const {
  getTypeWeights,
  listSuggestions,
  persistSuggestion,
  resetSuggestionStoreForTest,
} = await import("./store");

// ===== 真实 tmpdir store I/O（同 store.test.ts / feedback.test.ts） =====
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-suggest-int-"));
  process.env.LUME_CONFIG_DIR = root;
  resetSuggestionStoreForTest();
  spies.extractCalls.mockClear();
  spies.remember.mockClear();
  spies.createAutomationJob.mockClear();
  spies.broadcaster.mockClear();
  setSuggestionChangeBroadcaster(spies.broadcaster);
});

afterEach(() => {
  setSuggestionChangeBroadcaster(() => {});
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("建议系统端到端：signals → rules → engine → store → broadcast", () => {
  test("含纠正语的用户消息经评估落库为 correction 建议，并触发广播", async () => {
    // 初始空库
    expect(listSuggestions("suggested")).toHaveLength(0);
    expect(getTypeWeights().correction).toBe(1.0);

    await evaluateSessionSuggestions({
      threadId: "thread-1",
      workspaceSlug: "ws-1",
      sessionId: "session-1",
    });

    // adapter 被调用（消息确实被读取喂进管线）
    expect(spies.extractCalls).toHaveBeenCalledTimes(1);

    // 一条 correction 记录落库，status=suggested
    const suggested = listSuggestions("suggested");
    expect(suggested).toHaveLength(1);
    const rec = suggested[0]!;
    expect(rec.kind).toBe("correction");
    expect(rec.status).toBe("suggested");
    expect(rec.threadId).toBe("thread-1");
    expect(rec.workspaceSlug).toBe("ws-1");
    expect(rec.sessionId).toBe("session-1");
    // 动作正确：memory_correction + 规范化后的 rule
    expect(rec.action).toMatchObject({
      type: "memory_correction",
      rule: "不要用 var 声明变量",
    });

    // 广播器被调用（IPC 解耦钩子）
    expect(spies.broadcaster).toHaveBeenCalled();
  });

  test("全局开关关闭 → 不评估、不 persist、不广播", async () => {
    // 直接落库一条把 enabled 翻成 false（绕过 setEnabled，复用 store API）
    const { setEnabled } = await import("./store");
    setEnabled(false);

    await evaluateSessionSuggestions({
      threadId: "thread-disabled",
      workspaceSlug: "ws",
      sessionId: "session",
    });

    // 管线在 getEnabled() 检查处短路：adapter 未读、无候选落库、未广播
    expect(spies.extractCalls).not.toHaveBeenCalled();
    expect(listSuggestions("suggested")).toHaveLength(0);
    expect(spies.broadcaster).not.toHaveBeenCalled();
  });
});

describe("建议系统端到端：accepted 反馈 → 学习权重 + 触发记忆写入", () => {
  test("accepted memory_correction → MemoryCommandService 调用 + correction 权重 1.0→1.2", async () => {
    // 1) 跑完评估链路，得到一条 memory_correction 建议
    await evaluateSessionSuggestions({
      threadId: "thread-2",
      workspaceSlug: "ws-2",
      sessionId: "session-2",
    });
    const rec = listSuggestions("suggested")[0]!;
    expect(rec.action.type).toBe("memory_correction");
    // 反馈前 correction 权重仍为默认 1.0
    expect(getTypeWeights().correction).toBe(1.0);
    // 反馈前统一记忆命令未被调用
    expect(spies.remember).not.toHaveBeenCalled();

    // 2) 用户接受建议 → handleSuggestionFeedback 编排 recordFeedback + 动作分发
    await handleSuggestionFeedback(rec.id, "accepted");

    // 3) MemoryCommandService 被调用一次，参数携带规范化后的纠正规则
    expect(spies.remember).toHaveBeenCalledTimes(1);
    expect(spies.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: "ws-2",
        content: "不要用 var 声明变量",
        scope: "global",
        semanticRole: "preference",
        confidence: "high",
        facets: expect.arrayContaining(["correction", "suggestion-derived"]),
        explicitCorrection: true,
      }),
    );

    // 4) feedback 层频率学习：correction 权重 1.0 × 1.2 = 1.2
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);
    // record 状态被 recordFeedback 写回为 accepted
    const accepted = listSuggestions().find((r) => r.id === rec.id);
    expect(accepted?.status).toBe("accepted");
  });

  test("accepted memory_correction（无 workspaceSlug）→ 全局 scope + 权重 1.2", async () => {
    // 直接 persist 一条无 workspace 的 memory_correction 建议，跳过评估链路
    const rec = persistSuggestion({
      duplicateKey: "correction:manual",
      kind: "correction",
      title: "记住这个纠正",
      reason: "r",
      evidence: "e",
      rawConfidence: 0.95,
      action: { type: "memory_correction", raw: "以后别再 var", rule: "别再 var" },
    });

    await handleSuggestionFeedback(rec.id, "accepted");

    expect(spies.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: "global",
        scope: "global",
        content: "别再 var",
      }),
    );
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);
  });
});

describe("建议系统端到端：ignored 反馈不触发动作，仅调权", () => {
  test("ignored memory_correction → 记忆命令不调用 + correction 权重 1.0→0.8", async () => {
    await evaluateSessionSuggestions({
      threadId: "thread-3",
      workspaceSlug: "ws-3",
      sessionId: "session-3",
    });
    const rec = listSuggestions("suggested")[0]!;

    await handleSuggestionFeedback(rec.id, "ignored");

    expect(spies.remember).not.toHaveBeenCalled();
    expect(spies.createAutomationJob).not.toHaveBeenCalled();
    // 1.0 × 0.8 = 0.8
    expect(getTypeWeights().correction).toBeCloseTo(0.8, 6);
  });
});

describe("建议系统端到端：落盘持久化", () => {
  test("评估落库后清缓存从磁盘读回，记录与权重一致", async () => {
    await evaluateSessionSuggestions({
      threadId: "thread-4",
      workspaceSlug: "ws-4",
      sessionId: "session-4",
    });
    const before = listSuggestions("suggested")[0]!;

    // 清缓存模拟进程重启
    resetSuggestionStoreForTest();

    const after = listSuggestions("suggested");
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.kind).toBe("correction");
    expect(after[0]!.action.type).toBe("memory_correction");
    // 权重未受反馈影响，仍为默认 1.0
    expect(getTypeWeights().correction).toBe(1.0);
  });
});
