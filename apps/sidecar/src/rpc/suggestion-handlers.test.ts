import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  SUGGESTION_IPC_CHANNELS,
  type SuggestionFeedback,
  type SuggestionRecord,
  type SuggestionStats,
} from "@lume/shared";

/**
 * Handler 接线测试：mock store/service 模块，验证每个 channel 调对函数 + 透传参数。
 * 不验证业务逻辑（store/service 各自的 .test.ts 已覆盖）。
 */

const storeMocks = {
  listSuggestions: mock((_status?: SuggestionRecord["status"]): SuggestionRecord[] => []),
  deleteSuggestion: mock((_id: number): void => undefined),
  clearSuggestions: mock((): void => undefined),
  suggestionStats: mock(
    (): SuggestionStats => ({
      suggestedCount: 0,
      todayAccepted: 0,
      todayIgnored: 0,
      todayNever: 0,
      typeWeights: { correction: 1, followup: 1, automation: 1, skill: 0.8, todo: 0.9 },
    }),
  ),
  setEnabled: mock((_value: boolean): void => undefined),
};

const serviceMocks = {
  handleSuggestionFeedback: mock(
    (_id: number, _feedback: SuggestionFeedback): Promise<void> => Promise.resolve(),
  ),
  runAnalysisAndPersist: mock((_ctx: { workspaceSlug?: string }): Promise<number> =>
    Promise.resolve(0),
  ),
  setSuggestionChangeBroadcaster: mock((_fn: () => void): void => undefined),
};

const writeNotification = mock((_method: string, _params: unknown): void => undefined);

beforeEach(() => {
  mock.module("../services/suggest/store", () => storeMocks);
  mock.module("../services/suggest/service", () => serviceMocks);
  Object.values(storeMocks).forEach((m) => m.mockClear());
  Object.values(serviceMocks).forEach((m) => m.mockClear());
  writeNotification.mockClear();
});

afterEach(() => {
  mock.restore();
});

describe("createSuggestionHandlers", () => {
  test("LIST 直通 store.listSuggestions（无 status）", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.LIST]!({});
    expect(storeMocks.listSuggestions).toHaveBeenCalledTimes(1);
    expect(storeMocks.listSuggestions.mock.calls[0]).toEqual([undefined]);
  });

  test("LIST 透传 status 过滤参数", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.LIST]!({ status: "accepted" });
    expect(storeMocks.listSuggestions.mock.calls[0]).toEqual(["accepted"]);
  });

  test("LIST 非法 status → throw", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await expect(
      handlers[SUGGESTION_IPC_CHANNELS.LIST]!({ status: "bogus" }),
    ).rejects.toThrow(/suggestion:list/);
    expect(storeMocks.listSuggestions).not.toHaveBeenCalled();
  });

  test("ACT 调 service.handleSuggestionFeedback(id, feedback)", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    const result = await handlers[SUGGESTION_IPC_CHANNELS.ACT]!({ id: 7, feedback: "accepted" });
    expect(result).toEqual({ ok: true });
    expect(serviceMocks.handleSuggestionFeedback).toHaveBeenCalledTimes(1);
    expect(serviceMocks.handleSuggestionFeedback.mock.calls[0]).toEqual([7, "accepted"]);
  });

  test("ACT 非法 feedback → throw", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await expect(
      handlers[SUGGESTION_IPC_CHANNELS.ACT]!({ id: 7, feedback: "maybe" }),
    ).rejects.toThrow(/suggestion:act/);
    expect(serviceMocks.handleSuggestionFeedback).not.toHaveBeenCalled();
  });

  test("ACT 非正数 id → throw", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await expect(
      handlers[SUGGESTION_IPC_CHANNELS.ACT]!({ id: -1, feedback: "ignored" }),
    ).rejects.toThrow(/suggestion:act/);
    expect(serviceMocks.handleSuggestionFeedback).not.toHaveBeenCalled();
  });

  test("STATS 直通 store.suggestionStats", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.STATS]!(null);
    expect(storeMocks.suggestionStats).toHaveBeenCalledTimes(1);
  });

  test("DELETE 直通 store.deleteSuggestion(id)", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.DELETE]!({ id: 42 });
    expect(storeMocks.deleteSuggestion.mock.calls[0]).toEqual([42]);
  });

  test("CLEAR_ALL 直通 store.clearSuggestions", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.CLEAR_ALL]!(null);
    expect(storeMocks.clearSuggestions).toHaveBeenCalledTimes(1);
  });

  test("RUN_ANALYSIS 调 service.runAnalysisAndPersist({ workspaceSlug })", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    serviceMocks.runAnalysisAndPersist.mockResolvedValueOnce(3);
    const result = await handlers[SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS]!({ workspaceSlug: "demo" });
    expect(result).toEqual({ added: 3 });
    expect(serviceMocks.runAnalysisAndPersist.mock.calls[0]).toEqual([{ workspaceSlug: "demo" }]);
  });

  test("RUN_ANALYSIS 无参 → workspaceSlug undefined", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.RUN_ANALYSIS]!({});
    expect(serviceMocks.runAnalysisAndPersist.mock.calls[0]).toEqual([{ workspaceSlug: undefined }]);
  });

  test("SET_ENABLED 直通 store.setEnabled(bool)", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await handlers[SUGGESTION_IPC_CHANNELS.SET_ENABLED]!({ enabled: false });
    expect(storeMocks.setEnabled.mock.calls[0]).toEqual([false]);
  });

  test("SET_ENABLED 非 bool → throw", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const handlers = createSuggestionHandlers({ writeNotification });
    await expect(
      handlers[SUGGESTION_IPC_CHANNELS.SET_ENABLED]!({ enabled: "yes" }),
    ).rejects.toThrow(/suggestion:set-enabled/);
  });
});

describe("createSuggestionHandlers broadcaster 接线（Task 12）", () => {
  test("构造时注入 broadcaster：调用 service.setSuggestionChangeBroadcaster", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    createSuggestionHandlers({ writeNotification });
    expect(serviceMocks.setSuggestionChangeBroadcaster).toHaveBeenCalledTimes(1);
    const injected = serviceMocks.setSuggestionChangeBroadcaster.mock.calls[0]![0];
    expect(typeof injected).toBe("function");
  });

  test("注入的 broadcaster 经 writeNotification 推送 SUGGESTIONS_CHANGED", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    createSuggestionHandlers({ writeNotification });
    expect(serviceMocks.setSuggestionChangeBroadcaster).toHaveBeenCalledTimes(1);
    // 取出 handler 注入的 broadcaster 并直接调用，模拟 service.notifySuggestionsChanged
    const injectedBroadcaster = serviceMocks.setSuggestionChangeBroadcaster.mock.calls[0]![0] as () => void;
    writeNotification.mockClear();
    injectedBroadcaster();
    expect(writeNotification).toHaveBeenCalledTimes(1);
    expect(writeNotification.mock.calls[0]).toEqual([
      SUGGESTION_IPC_CHANNELS.CHANGED,
      { type: "suggestions_changed" },
    ]);
  });

  test("channel 推送抛错由 broadcaster 直接抛出（fail-open 责任在 service.notifySuggestionsChanged 的 try/catch）", async () => {
    const { createSuggestionHandlers } = await import("./suggestion-handlers");
    const brokenChannel = mock((): void => {
      throw new Error("channel down");
    });
    createSuggestionHandlers({ writeNotification: brokenChannel });
    const injectedBroadcaster = serviceMocks.setSuggestionChangeBroadcaster.mock.calls[0]![0] as () => void;
    // broadcaster 自身不做 try/catch —— service.notifySuggestionsChanged 包了 try/catch
    // 吞掉错误并 log.warn，确保推送失败不破坏持久化（service.test.ts 已覆盖 fail-open）。
    expect(injectedBroadcaster).toThrow("channel down");
  });
});
