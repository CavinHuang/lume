import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PERSONA_IPC_CHANNELS, type PersonaGetResult } from "@lume/shared";

/**
 * Handler 接线测试：mock persona 模块，验证每个 channel 调对函数 + 透传参数。
 * 不验证业务逻辑（persona.test.ts 已覆盖）。
 */

const personaMocks = {
  readPersonaRaw: mock((): string | null => null),
  parsePersonaProfile: mock((_md: string): PersonaGetResult["parsed"] => ({
    preferences: [],
    interactionRules: [],
    evolution: [],
  })),
  ensurePersona: mock(
    (_input: { providerFactory?: unknown }): Promise<boolean> =>
      Promise.resolve(true),
  ),
  getPersonaPath: mock((_scope: "global"): string => "/tmp/persona.md"),
};

beforeEach(() => {
  mock.module("../services/memory-v2/persona", () => personaMocks);
  mock.module("../services/memory-v2/types", () => ({}));
  Object.values(personaMocks).forEach((m) => m.mockClear());
});

afterEach(() => {
  mock.restore();
});

describe("createPersonaHandlers", () => {
  test("GET markdown=null → 返回空响应（不调 parsePersonaProfile 之外的副作用）", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    personaMocks.readPersonaRaw.mockReturnValueOnce(null);
    const result = (await handlers[PERSONA_IPC_CHANNELS.GET]!({})) as PersonaGetResult;
    expect(result.markdown).toBe("");
    expect(result.parsed).toEqual({ preferences: [], interactionRules: [], evolution: [] });
    expect(result.updatedAt).toBeUndefined();
    expect(personaMocks.readPersonaRaw).toHaveBeenCalledTimes(1);
    // parsePersonaProfile 被调用一次（用于构造空 parsed）
    expect(personaMocks.parsePersonaProfile).toHaveBeenCalledTimes(1);
    expect(personaMocks.parsePersonaProfile.mock.calls[0]).toEqual([""]);
  });

  test("GET 有 markdown → 始终读取 global 派生画像", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    const md = "# 用户画像\n## 用户（称呼）\n小明";
    personaMocks.readPersonaRaw.mockReturnValueOnce(md);
    personaMocks.parsePersonaProfile.mockReturnValueOnce({
      name: "小明",
      preferences: [],
      interactionRules: [],
      evolution: [],
    });
    const result = (await handlers[PERSONA_IPC_CHANNELS.GET]!({})) as PersonaGetResult;
    expect(result.markdown).toBe(md);
    expect(result.parsed.name).toBe("小明");
    expect(personaMocks.readPersonaRaw.mock.calls[0]).toEqual([]);
    expect(personaMocks.parsePersonaProfile.mock.calls[0]).toEqual([md]);
  });

  test("GET 非法 scope → throw", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.GET]!({ scope: "bogus" }),
    ).rejects.toThrow(/persona:get/);
    expect(personaMocks.readPersonaRaw).not.toHaveBeenCalled();
  });

  test("GET 未知字段 → strict 校验 throw", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.GET]!({ foo: "bar" }),
    ).rejects.toThrow(/persona:get/);
  });

  test("REGENERATE 调 ensurePersona（无参入参）", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    const result = await handlers[PERSONA_IPC_CHANNELS.REGENERATE]!({});
    expect(result).toEqual({ ok: true });
    expect(personaMocks.ensurePersona).toHaveBeenCalledTimes(1);
    expect(personaMocks.ensurePersona.mock.calls[0]).toEqual([{}]);
  });

  test("REGENERATE 非法 scope → throw（不调 ensurePersona）", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.REGENERATE]!({ scope: "bogus" }),
    ).rejects.toThrow(/persona:regenerate/);
    expect(personaMocks.ensurePersona).not.toHaveBeenCalled();
  });
});
