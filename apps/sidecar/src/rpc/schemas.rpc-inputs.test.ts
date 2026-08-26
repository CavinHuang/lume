/**
 * #522 八个新 RPC 入参 schema 的回归防线(review 补测):
 * 此前这些 handler 走裸 cast,desktop 端载荷形状漂移会静默通过;收口后
 * strict schema "非法即 throw"——若 desktop 发送 schema 外多余字段,合并后
 * 将直接运行时 throw 而 CI 全绿,故逐 schema 钉死"现网最小合法载荷通过 +
 * 多余字段拒绝"。desktopAssistantSettingsInputSchema 为 strip 模式(settings
 * 整体替换语义),验证的是剥离而非拒绝。
 */
import { describe, expect, test } from "bun:test";
import {
  agentGenerateTitleInputSchema,
  agentWelcomeSuggestionInputSchema,
  desktopAssistantSettingsInputSchema,
  forkThreadInputSchema,
  githubReleaseListOptionsSchema,
  routineGetByDateInputSchema,
  routineTriggerEntryInputSchema,
  testSearchBackendInputSchema
} from "./schemas";

describe("#522 rpc input schemas", () => {
  test("forkThread:现网载荷 {threadId,upToMessageId} 通过,多余/空值拒绝", () => {
    const input = { threadId: "t-1", upToMessageId: "m-1" };
    expect(forkThreadInputSchema.parse(input)).toEqual(input);
    expect(() => forkThreadInputSchema.parse({ ...input, extra: true })).toThrow();
    expect(() => forkThreadInputSchema.parse({ threadId: "", upToMessageId: "m-1" })).toThrow();
  });

  test("routineGetByDate:date 合法通过,多余字段拒绝", () => {
    expect(routineGetByDateInputSchema.parse({ date: "2026-08-26" })).toEqual({ date: "2026-08-26" });
    expect(() => routineGetByDateInputSchema.parse({ date: "d", extra: 1 })).toThrow();
  });

  test("routineTriggerEntry:entryId 合法通过,缺失拒绝", () => {
    expect(routineTriggerEntryInputSchema.parse({ entryId: "e-1" })).toEqual({ entryId: "e-1" });
    expect(() => routineTriggerEntryInputSchema.parse({})).toThrow();
  });

  test("testSearchBackend:七值 provider 白名单,枚举外与多余字段拒绝", () => {
    const minimal = { provider: "exa" as const };
    expect(testSearchBackendInputSchema.parse(minimal)).toEqual(minimal);
    expect(testSearchBackendInputSchema.parse({ provider: "bing", apiKey: "k" })).toEqual({ provider: "bing", apiKey: "k" });
    expect(() => testSearchBackendInputSchema.parse({ provider: "not-a-provider" })).toThrow();
    expect(() => testSearchBackendInputSchema.parse({ provider: "exa", extra: 1 })).toThrow();
  });

  test("githubReleaseList:全 optional 分页项,非正整数拒绝", () => {
    expect(githubReleaseListOptionsSchema.parse({})).toEqual({});
    expect(githubReleaseListOptionsSchema.parse({ perPage: 10, page: 2, includePrerelease: true })).toEqual({
      perPage: 10,
      page: 2,
      includePrerelease: true
    });
    expect(() => githubReleaseListOptionsSchema.parse({ perPage: 0 })).toThrow();
    expect(() => githubReleaseListOptionsSchema.parse({ perPage: 1.5 })).toThrow();
  });

  test("agentGenerateTitle:五 optional 字段自由组合,多余字段拒绝", () => {
    expect(agentGenerateTitleInputSchema.parse({})).toEqual({});
    const partial = { sourceText: "s", modelRef: "anthropic/claude" };
    expect(agentGenerateTitleInputSchema.parse(partial)).toEqual(partial);
    expect(() => agentGenerateTitleInputSchema.parse({ ...partial, channelId: undefined, extra: 1 })).toThrow();
  });

  test("agentWelcomeSuggestion:双 optional 字段通过,多余字段拒绝", () => {
    const input = { workspaceSlug: "demo", workspaceName: "Demo" };
    expect(agentWelcomeSuggestionInputSchema.parse(input)).toEqual(input);
    expect(() => agentWelcomeSuggestionInputSchema.parse({ ...input, extra: 1 })).toThrow();
  });

  test("desktopAssistantSettings(strip 模式):必填齐备通过且未知字段被剥离,缺必填拒绝", () => {
    const full = {
      enabled: true,
      allowedApps: ["Code.exe"],
      retentionHours: 24,
      maxStorageBytes: 1024,
      proactiveEnabled: false,
      notificationsEnabled: true,
      dailyWrapEnabled: false
    };
    expect(desktopAssistantSettingsInputSchema.parse(full)).toEqual(full);
    // renderer 回传 GET_SETTINGS 快照时夹带的未知键必须被剥掉,不得透传持久化。
    const withExtra = { ...full, attackerKey: "x" };
    const parsed = desktopAssistantSettingsInputSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty("attackerKey");
    expect(() =>
      desktopAssistantSettingsInputSchema.parse({ enabled: true, allowedApps: [] })
    ).toThrow();
  });
});
