import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PERSONA_IPC_CHANNELS, type PersonaGetResult } from "@lume/shared";

/**
 * Handler 接线测试：mock persona 模块，验证每个 channel 调对函数 + 透传参数。
 * 不验证业务逻辑（persona.test.ts 已覆盖）。
 */

const personaMocks = {
  readPersonaRaw: mock(
    (_scope: "global" | "workspace", _workspaceSlug?: string): string | null => null,
  ),
  writePersona: mock(
    (_scope: "global" | "workspace", _workspaceSlug: string | undefined, _markdown: string): void => undefined,
  ),
  parsePersonaProfile: mock((_md: string): PersonaGetResult["parsed"] => ({
    preferences: [],
    interactionRules: [],
    evolution: [],
  })),
  ensurePersona: mock(
    (_input: { scope?: "global" | "workspace"; workspaceSlug?: string }): Promise<void> =>
      Promise.resolve(),
  ),
  getPersonaPath: mock((_scope: "global" | "workspace", _workspaceSlug?: string): string => "/tmp/persona.md"),
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
    const result = (await handlers[PERSONA_IPC_CHANNELS.GET]!({
      scope: "workspace",
      workspaceSlug: "demo",
    })) as PersonaGetResult;
    expect(result.markdown).toBe(md);
    expect(result.parsed.name).toBe("小明");
    expect(personaMocks.readPersonaRaw.mock.calls[0]).toEqual(["global"]);
    expect(personaMocks.parsePersonaProfile.mock.calls[0]).toEqual([md]);
  });

  test("GET 仅传 workspaceSlug → 仍读取 global Persona", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    personaMocks.readPersonaRaw.mockReturnValueOnce(null);
    await handlers[PERSONA_IPC_CHANNELS.GET]!({ workspaceSlug: "demo" });
    expect(personaMocks.readPersonaRaw.mock.calls[0]).toEqual(["global"]);
  });

  test("GET 无参 → scope 默认 global、workspaceSlug undefined", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    personaMocks.readPersonaRaw.mockReturnValueOnce(null);
    await handlers[PERSONA_IPC_CHANNELS.GET]!({});
    expect(personaMocks.readPersonaRaw.mock.calls[0]).toEqual(["global", undefined]);
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

  test("UPDATE 拒绝直接修改派生 persona Markdown", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(handlers[PERSONA_IPC_CHANNELS.UPDATE]!({
      scope: "workspace",
      workspaceSlug: "demo",
      markdown: "# 新画像",
    })).rejects.toThrow("派生视图");
    expect(personaMocks.writePersona).toHaveBeenCalledTimes(0);
  });

  test("UPDATE 空 markdown → throw", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.UPDATE]!({ markdown: "" }),
    ).rejects.toThrow(/persona:update/);
    expect(personaMocks.writePersona).not.toHaveBeenCalled();
  });

  test("UPDATE 缺 markdown 字段 → throw", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.UPDATE]!({ scope: "global" }),
    ).rejects.toThrow(/persona:update/);
    expect(personaMocks.writePersona).not.toHaveBeenCalled();
  });

  test("UPDATE 非字符串 markdown → throw", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await expect(
      handlers[PERSONA_IPC_CHANNELS.UPDATE]!({ markdown: 123 }),
    ).rejects.toThrow(/persona:update/);
    expect(personaMocks.writePersona).not.toHaveBeenCalled();
  });

  test("REGENERATE 调 ensurePersona 透传 scope/workspaceSlug", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    const result = await handlers[PERSONA_IPC_CHANNELS.REGENERATE]!({
      scope: "workspace",
      workspaceSlug: "demo",
    });
    expect(result).toEqual({ ok: true });
    expect(personaMocks.ensurePersona).toHaveBeenCalledTimes(1);
    expect(personaMocks.ensurePersona.mock.calls[0]).toEqual([{ scope: "global" }]);
  });

  test("REGENERATE 无参 → 透传 undefined（ensurePersona 内部默认 global）", async () => {
    const { createPersonaHandlers } = await import("./persona-handlers");
    const handlers = createPersonaHandlers();
    await handlers[PERSONA_IPC_CHANNELS.REGENERATE]!({});
    expect(personaMocks.ensurePersona.mock.calls[0]).toEqual([{ scope: "global" }]);
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
