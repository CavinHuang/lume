/**
 * #522 八个新 RPC 入参 schema 回归防线(review 补测):strict schema 下
 * desktop 载荷漂移会运行时 throw 而 CI 全绿,故逐 schema 钉死"合法载荷通过 +
 * 多余字段拒绝"。
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

  test("routineTriggerEntry:entryId 合法通过,缺失/多余拒绝", () => {
    expect(routineTriggerEntryInputSchema.parse({ entryId: "e-1" })).toEqual({ entryId: "e-1" });
    expect(() => routineTriggerEntryInputSchema.parse({})).toThrow();
    expect(() => routineTriggerEntryInputSchema.parse({ entryId: "e-1", extra: 1 })).toThrow();
  });

  test("testSearchBackend:七值 provider 白名单,枚举外与多余字段拒绝", () => {
    const minimal = { provider: "exa" as const };
    expect(testSearchBackendInputSchema.parse(minimal)).toEqual(minimal);
    expect(testSearchBackendInputSchema.parse({ provider: "bing", apiKey: "k" })).toEqual({ provider: "bing", apiKey: "k" });
    expect(() => testSearchBackendInputSchema.parse({ provider: "not-a-provider" })).toThrow();
    expect(() => testSearchBackendInputSchema.parse({ provider: "exa", extra: 1 })).toThrow();
  });

  test("githubReleaseList:全 optional 分页项,int+positive 在两个字段上都钉死", () => {
    expect(githubReleaseListOptionsSchema.parse({})).toEqual({});
    expect(githubReleaseListOptionsSchema.parse({ perPage: 10, page: 2, includePrerelease: true })).toEqual({
      perPage: 10,
      page: 2,
      includePrerelease: true
    });
    // perPage 与 page 逐一变异(page 此前零拒绝路径)
    for (const bad of [{ perPage: 0 }, { perPage: 1.5 }, { page: 0 }, { page: -3 }, { page: 0.5 }]) {
      expect(() => githubReleaseListOptionsSchema.parse(bad)).toThrow();
    }
    expect(() => githubReleaseListOptionsSchema.parse({ page: 1, extra: 1 })).toThrow();
  });

  test("agentGenerateTitle:五 optional 字段全量载荷与空对象均通过,多余字段拒绝", () => {
    expect(agentGenerateTitleInputSchema.parse({})).toEqual({});
    const full = {
      sourceText: "s",
      userMessage: "m",
      modelRef: "anthropic/claude",
      channelId: "c-1",
      modelId: "claude"
    };
    expect(agentGenerateTitleInputSchema.parse(full)).toEqual(full);
    expect(() => agentGenerateTitleInputSchema.parse({ ...full, extra: 1 })).toThrow();
  });

  test("agentWelcomeSuggestion:双 optional 字段通过,多余字段拒绝", () => {
    const input = { workspaceSlug: "demo", workspaceName: "Demo" };
    expect(agentWelcomeSuggestionInputSchema.parse(input)).toEqual(input);
    expect(() => agentWelcomeSuggestionInputSchema.parse({ ...input, extra: 1 })).toThrow();
  });

  test("desktopAssistantSettings(strip 模式):最小必填载荷通过(旧快照无 optional 三键),未知字段剥离;缺必填拒绝", () => {
    // renderer 回传旧版 GET_SETTINGS 快照的真实形态:后加 optional 三键不存在。
    const minimal = {
      enabled: false,
      allowedApps: [],
      retentionHours: 24,
      maxStorageBytes: 1024
    };
    expect(desktopAssistantSettingsInputSchema.parse(minimal)).toEqual(minimal);
    expect(desktopAssistantSettingsInputSchema.parse({ ...minimal, attackerKey: "x" }))
      .not.toHaveProperty("attackerKey");
    expect(() =>
      desktopAssistantSettingsInputSchema.parse({ enabled: true, allowedApps: [] })
    ).toThrow();
  });

  test("desktopAssistantSettings(strip 模式):完整八键载荷通过且未知字段被剥离,缺必填拒绝", () => {
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
