/**
 * service.test.ts — 编排层测试
 *
 * 策略：用 mock.module 隔离所有依赖（store/engine/feedback/analyst/adapter/rules/
 * automation-manager/smart-add/logger），用 mutable state + mock spies 验证编排逻辑。
 * 这些依赖各自的单元测试已覆盖自身行为，此处只关心 service 的"装配 + 编排 + fail-open"。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  SuggestionCandidate,
  SuggestionFeedback,
  SuggestionKind,
  SuggestionRecord,
  SuggestionTypeWeights,
} from "@lume/shared";

// ===== 可变状态 + spy =====
const ALL_KINDS: SuggestionKind[] = ["correction", "followup", "automation", "todo", "skill"];

const state = {
  enabled: true,
  typeWeights: {
    correction: 1,
    followup: 1,
    automation: 1,
    skill: 1,
    todo: 1,
  } as SuggestionTypeWeights,
  records: [] as SuggestionRecord[],
  neverKeys: new Set<string>(),
  silencedKinds: new Set<SuggestionKind>(),
  dedupContext: { automationTitles: [] as string[], correctionRules: [] as string[], sopCandidateCount: 0 },
  evalCandidates: [] as SuggestionCandidate[],
  analysisCandidates: [] as SuggestionCandidate[],
  extractedMessages: [{ role: "user", content: "以后不要用 var" }] as {
    role: "user";
    content: string;
  }[],
  extractThrow: false,
  evalThrow: false,
  analysisThrow: false,
};

const spies = {
  persistSuggestion: mock((candidate: SuggestionCandidate, ctx?: object): SuggestionRecord => {
    const rec: SuggestionRecord = {
      ...candidate,
      id: state.records.length + 1,
      status: "suggested",
      createdAt: Date.now(),
      sessionId: (ctx as { sessionId?: string })?.sessionId,
      threadId: (ctx as { threadId?: string })?.threadId,
      workspaceSlug: (ctx as { workspaceSlug?: string })?.workspaceSlug,
    };
    state.records.push(rec);
    return rec;
  }),
  recordFeedback: mock((_id: number, _fb: SuggestionFeedback) => {}),
  createAutomationJob: mock((input: { name: string; prompt: string; schedule: unknown }) => ({
    id: "job-1",
    ...input,
  })),
  smartAdd: mock(async (_input: { workspaceSlug?: string; candidate: object }) => ({
    action: "added",
  })),
  ensurePersona: mock(async (_input: { workspaceSlug?: string }) => {}),
  broadcaster: mock(() => {}),
};

// ===== mock.module 依赖 =====
mock.module("./store", () => ({
  getEnabled: () => state.enabled,
  getTypeWeights: () => ({ ...state.typeWeights }),
  listSuggestions: (status?: SuggestionRecord["status"]) =>
    status ? state.records.filter((r) => r.status === status) : [...state.records],
  persistSuggestion: spies.persistSuggestion,
  updateSuggestionStatus: (id: number, status: SuggestionRecord["status"]) => {
    state.records = state.records.map((r) =>
      r.id === id ? { ...r, status, feedbackAt: Date.now() } : r,
    );
  },
}));

mock.module("./engine", () => ({
  evaluateSuggestions: (_messages: unknown, _opts: unknown) => {
    if (state.evalThrow) throw new Error("engine boom");
    return { candidates: [...state.evalCandidates], suppressed: [] };
  },
}));

mock.module("./feedback", () => ({
  recordFeedback: spies.recordFeedback,
  isTypeSilenced: (kind: SuggestionKind) => state.silencedKinds.has(kind),
  getNeverKeys: () => new Set(state.neverKeys),
}));

mock.module("./analyst", () => ({
  buildAnalysisInput: (_opts?: object) => "fake-context",
  runAnalysis: async (_input: object) => {
    if (state.analysisThrow) throw new Error("analyst boom");
    return [...state.analysisCandidates];
  },
}));

mock.module("./adapter", () => ({
  extractRecentConversation: async (_input: object) => {
    if (state.extractThrow) throw new Error("adapter boom");
    return [...state.extractedMessages];
  },
}));

mock.module("./rules", () => ({
  loadDedupContext: () => ({ ...state.dedupContext }),
}));

mock.module("../automation/automation-manager", () => ({
  createAutomationJob: spies.createAutomationJob,
}));

mock.module("../memory-v2/smart-add", () => ({
  smartAddMemoryV2Candidate: spies.smartAdd,
}));

mock.module("../memory-v2/persona", () => ({
  ensurePersona: spies.ensurePersona,
}));

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

const { evaluateSessionSuggestions, handleSuggestionFeedback, runAnalysisAndPersist, setSuggestionChangeBroadcaster } =
  await import("./service");

// ===== helpers =====
function resetState(): void {
  state.enabled = true;
  state.typeWeights = { correction: 1, followup: 1, automation: 1, skill: 1, todo: 1 };
  state.records = [];
  state.neverKeys = new Set();
  state.silencedKinds = new Set();
  state.dedupContext = { automationTitles: [], correctionRules: [], sopCandidateCount: 0 };
  state.evalCandidates = [];
  state.analysisCandidates = [];
  state.extractedMessages = [{ role: "user", content: "以后不要用 var" }];
  state.extractThrow = false;
  state.evalThrow = false;
  state.analysisThrow = false;
  spies.persistSuggestion.mockClear();
  spies.recordFeedback.mockClear();
  spies.createAutomationJob.mockClear();
  spies.smartAdd.mockClear();
  spies.ensurePersona.mockClear();
  spies.broadcaster.mockClear();
}

const correctionCandidate: SuggestionCandidate = {
  duplicateKey: "correction:test",
  kind: "correction",
  title: "记住这个纠正",
  reason: "r",
  evidence: "e",
  rawConfidence: 0.95,
  action: { type: "memory_correction", raw: "以后不要用 var", rule: "不要用 var" },
};

const automationCandidate: SuggestionCandidate = {
  duplicateKey: "automation:每日汇总",
  kind: "automation",
  title: "开启定时任务",
  reason: "r",
  evidence: "e",
  rawConfidence: 0.9,
  action: { type: "open_automation_create", automationTitle: "每日汇总", suggestedPrompt: "汇总今日进度" },
};

// ===== tests =====
describe("evaluateSessionSuggestions", () => {
  beforeEach(() => {
    resetState();
    setSuggestionChangeBroadcaster(spies.broadcaster);
  });
  afterEach(() => setSuggestionChangeBroadcaster(() => {}));

  test("enabled=false → 不评估、不 persist", async () => {
    state.enabled = false;
    state.evalCandidates = [correctionCandidate];
    await evaluateSessionSuggestions({ threadId: "t1", sessionId: "s1" });
    expect(spies.persistSuggestion).not.toHaveBeenCalled();
    expect(spies.broadcaster).not.toHaveBeenCalled();
  });

  test("同会话已有 ≥ maxPerSession(2) 条 suggested → 不评估", async () => {
    state.evalCandidates = [correctionCandidate];
    // 预置 2 条同会话 suggested
    state.records = [
      { ...correctionCandidate, id: 1, status: "suggested", createdAt: 0, sessionId: "s1" },
      { ...correctionCandidate, id: 2, status: "suggested", createdAt: 0, sessionId: "s1", duplicateKey: "other" },
    ];
    await evaluateSessionSuggestions({ threadId: "t1", sessionId: "s1" });
    expect(spies.persistSuggestion).not.toHaveBeenCalled();
  });

  test("happy path → persist + 广播", async () => {
    state.evalCandidates = [correctionCandidate];
    await evaluateSessionSuggestions({ threadId: "t1", workspaceSlug: "ws", sessionId: "s1" });
    expect(spies.persistSuggestion).toHaveBeenCalledTimes(1);
    expect(spies.persistSuggestion).toHaveBeenCalledWith(
      correctionCandidate,
      { threadId: "t1", workspaceSlug: "ws", sessionId: "s1" },
    );
    expect(spies.broadcaster).toHaveBeenCalled();
  });

  test("engine 抛错 → fail-open（不抛、不 persist）", async () => {
    state.evalThrow = true;
    await evaluateSessionSuggestions({ threadId: "t1", sessionId: "s1" });
    expect(spies.persistSuggestion).not.toHaveBeenCalled();
  });

  test("adapter 抛错 → fail-open", async () => {
    state.extractThrow = true;
    await evaluateSessionSuggestions({ threadId: "t1", sessionId: "s1" });
    expect(spies.persistSuggestion).not.toHaveBeenCalled();
  });
});

describe("handleSuggestionFeedback", () => {
  beforeEach(() => {
    resetState();
    setSuggestionChangeBroadcaster(spies.broadcaster);
  });
  afterEach(() => setSuggestionChangeBroadcaster(() => {}));

  test("recordFeedback 总是被调用（任何反馈）", async () => {
    state.records = [{ ...correctionCandidate, id: 5, status: "suggested", createdAt: 0 }];
    await handleSuggestionFeedback(5, "ignored");
    expect(spies.recordFeedback).toHaveBeenCalledWith(5, "ignored");
    expect(spies.smartAdd).not.toHaveBeenCalled();
    expect(spies.createAutomationJob).not.toHaveBeenCalled();
  });

  test("accepted + memory_correction → smartAddMemoryV2Candidate 调用（带 correction tag）", async () => {
    state.records = [{ ...correctionCandidate, id: 5, status: "suggested", createdAt: 0, workspaceSlug: "ws" }];
    await handleSuggestionFeedback(5, "accepted");
    expect(spies.recordFeedback).toHaveBeenCalledWith(5, "accepted");
    expect(spies.smartAdd).toHaveBeenCalledTimes(1);
    expect(spies.smartAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: "ws",
        candidate: expect.objectContaining({
          kind: "preference",
          statement: "不要用 var",
          confidence: "high",
          tags: expect.arrayContaining(["correction", "suggestion-derived"]),
        }),
      }),
    );
  });

  test("accepted + open_automation_create → createAutomationJob（manual schedule）", async () => {
    state.records = [
      { ...automationCandidate, id: 7, status: "suggested", createdAt: 0 },
    ];
    await handleSuggestionFeedback(7, "accepted");
    expect(spies.createAutomationJob).toHaveBeenCalledTimes(1);
    expect(spies.createAutomationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "每日汇总",
        schedule: { type: "manual" },
        prompt: "汇总今日进度",
      }),
    );
  });

  test("accepted + open_memory_board → no-op（仅 recordFeedback）", async () => {
    const todo: SuggestionRecord = {
      duplicateKey: "todo:x",
      kind: "todo",
      title: "t",
      reason: "r",
      evidence: "e",
      rawConfidence: 0.9,
      action: { type: "open_memory_board" },
      id: 9,
      status: "suggested",
      createdAt: 0,
    };
    state.records = [todo];
    await handleSuggestionFeedback(9, "accepted");
    expect(spies.recordFeedback).toHaveBeenCalledWith(9, "accepted");
    expect(spies.smartAdd).not.toHaveBeenCalled();
    expect(spies.createAutomationJob).not.toHaveBeenCalled();
  });

  test("smartAdd 抛错 → fail-open（不向上传播）", async () => {
    state.records = [{ ...correctionCandidate, id: 5, status: "suggested", createdAt: 0 }];
    spies.smartAdd.mockImplementation(async () => {
      throw new Error("smartAdd boom");
    });
    await expect(handleSuggestionFeedback(5, "accepted")).resolves.toBeUndefined();
    spies.smartAdd.mockImplementation(async () => ({ action: "added" }));
  });

  test("accepted + memory_correction → 由 memory mutation 失效派生画像，不直接调用 ensurePersona", async () => {
    state.records = [
      { ...correctionCandidate, id: 5, status: "suggested", createdAt: 0, workspaceSlug: "ws" },
    ];
    await handleSuggestionFeedback(5, "accepted");
    expect(spies.ensurePersona).toHaveBeenCalledTimes(0);
  });

  test("ignored → ensurePersona 不回流", async () => {
    state.records = [
      { ...correctionCandidate, id: 5, status: "suggested", createdAt: 0, workspaceSlug: "ws" },
    ];
    await handleSuggestionFeedback(5, "ignored");
    expect(spies.ensurePersona).not.toHaveBeenCalled();
  });

  test("never → ensurePersona 不回流", async () => {
    state.records = [
      { ...correctionCandidate, id: 5, status: "suggested", createdAt: 0, workspaceSlug: "ws" },
    ];
    await handleSuggestionFeedback(5, "never");
    expect(spies.ensurePersona).not.toHaveBeenCalled();
  });

  test("accepted + open_automation_create → ensurePersona 不回流（仅 memory_correction 回流）", async () => {
    state.records = [
      { ...automationCandidate, id: 7, status: "suggested", createdAt: 0, workspaceSlug: "ws" },
    ];
    await handleSuggestionFeedback(7, "accepted");
    expect(spies.ensurePersona).not.toHaveBeenCalled();
  });

  test("ensurePersona 抛错 → fail-open（不阻塞反馈流）", async () => {
    state.records = [
      { ...correctionCandidate, id: 5, status: "suggested", createdAt: 0, workspaceSlug: "ws" },
    ];
    spies.ensurePersona.mockImplementation(async () => {
      throw new Error("persona boom");
    });
    await expect(handleSuggestionFeedback(5, "accepted")).resolves.toBeUndefined();
    spies.ensurePersona.mockImplementation(async () => {});
  });
});

describe("runAnalysisAndPersist", () => {
  beforeEach(() => {
    resetState();
    setSuggestionChangeBroadcaster(spies.broadcaster);
  });
  afterEach(() => setSuggestionChangeBroadcaster(() => {}));

  test("去重 neverKeys + 已 suggested，返回新增数", async () => {
    state.analysisCandidates = [
      { ...automationCandidate, duplicateKey: "automation:new" },
      { ...automationCandidate, duplicateKey: "automation:never" },
      { ...automationCandidate, duplicateKey: "automation:existing" },
    ];
    state.neverKeys = new Set(["automation:never"]);
    state.records = [
      { ...automationCandidate, id: 1, status: "suggested", createdAt: 0, duplicateKey: "automation:existing" },
    ];
    const count = await runAnalysisAndPersist({ workspaceSlug: "ws" });
    expect(count).toBe(1);
    expect(spies.persistSuggestion).toHaveBeenCalledTimes(1);
    expect(spies.broadcaster).toHaveBeenCalledTimes(1);
  });

  test("runAnalysis 抛错 → fail-open 返回 0", async () => {
    state.analysisThrow = true;
    const count = await runAnalysisAndPersist({ workspaceSlug: "ws" });
    expect(count).toBe(0);
    expect(spies.persistSuggestion).not.toHaveBeenCalled();
  });
});

describe("setSuggestionChangeBroadcaster", () => {
  beforeEach(() => resetState());

  test("注入的 broadcaster 在 persist 后被调用", async () => {
    state.evalCandidates = [correctionCandidate];
    const customBroadcaster = mock(() => {});
    setSuggestionChangeBroadcaster(customBroadcaster);
    await evaluateSessionSuggestions({ threadId: "t1", sessionId: "s1" });
    expect(customBroadcaster).toHaveBeenCalled();
    setSuggestionChangeBroadcaster(() => {});
  });
});
