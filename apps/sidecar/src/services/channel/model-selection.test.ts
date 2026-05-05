import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  normalizeProviderId,
  parseModelRef,
  resolveAgentDefaultStrategy,
  resolveModelCandidatesForChannel,
  resolveChannelDefaultModelId,
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "./model-selection";

const capturedRuntimeCalls: Array<{
  input?: { channelId?: string; modelId?: string };
  runtime?: { modelRef?: string; channelId?: string };
}> = [];

mock.module("../pi-agent/runtime-core/attempt", () => ({
  runPiAgent: async (
    params: {
      input?: { channelId?: string; modelId?: string };
      runtime?: { modelRef?: string; channelId?: string };
    },
    emit: {
      onComplete: () => void;
    }
  ) => {
    capturedRuntimeCalls.push(params);
    emit.onComplete();
    return { status: "completed" as const };
  },
  stopPiAgent: () => undefined,
  isPiAgentSessionActive: () => false
}));

describe("model-selection", () => {
  let previousConfigDir: string | undefined;
  let previousSecretSeed: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    previousSecretSeed = process.env.LUME_SECRET_SEED;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-model-selection-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    process.env.LUME_SECRET_SEED = "model-selection-test-seed";
    capturedRuntimeCalls.length = 0;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (previousSecretSeed === undefined) {
      delete process.env.LUME_SECRET_SEED;
    } else {
      process.env.LUME_SECRET_SEED = previousSecretSeed;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("normalizeProviderId 应兼容历史 provider 别名", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("z-ai")).toBe("zai");
    expect(normalizeProviderId("zhipu")).toBe("zai");
    expect(normalizeProviderId("qwen")).toBe("qwen-portal");
    expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
  });

  test("parseModelRef 应支持 provider/model 与默认 provider", () => {
    expect(parseModelRef("zai/glm-5", "openai")).toEqual({
      provider: "zai",
      model: "glm-5"
    });
    expect(parseModelRef("glm-5", "zhipu")).toEqual({
      provider: "zai",
      model: "glm-5"
    });
  });

  test("openrouter baseUrl 应强制走 openai 适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "anthropic/claude-sonnet-4-5"
    });
    expect(resolved.adapterProvider).toBe("openai");
    expect(resolved.resolvedModelId).toBe("claude-sonnet-4-5");
    expect(resolved.modelRef).toBe("anthropic/claude-sonnet-4-5");
  });

  test("zai 模型在 bigmodel baseUrl 下应走 openai 兼容适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "zai/glm-5"
    });
    expect(resolved.adapterProvider).toBe("openai");
    expect(resolved.resolvedModelId).toBe("glm-5");
  });

  test("bigmodel anthropic endpoint 应走 anthropic 适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      modelId: "glm-4.7"
    });
    expect(resolved.adapterProvider).toBe("anthropic");
    expect(resolved.resolvedModelId).toBe("glm-4.7");
  });

  test("anthropic-compatible provider 应走 anthropic 适配器", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "anthropic-compatible",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-5"
    });
    expect(resolved.adapterProvider).toBe("anthropic");
    expect(resolved.modelRef).toBe("anthropic-compatible/claude-sonnet-4-5");
  });

  test("deepseek provider 应保留独立适配器而不是折叠为 openai", () => {
    const resolved = resolveChannelModelSelection({
      channelProvider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat"
    });
    expect(resolved.adapterProvider).toBe("deepseek");
    expect(resolved.resolvedModelId).toBe("deepseek-chat");
    expect(resolved.modelRef).toBe("deepseek/deepseek-chat");
  });

  test("resolveRequestedModelIdForChannel 应支持 alias/name/default", () => {
    const channel = {
      models: [
        { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", alias: "mini", enabled: true },
        { id: "zai/glm-5", name: "GLM 5", enabled: false }
      ],
      defaultModelId: "openai/gpt-4.1-mini",
      fallbackModelIds: ["zai/glm-5"]
    };
    expect(resolveRequestedModelIdForChannel(channel, "mini")).toBe("openai/gpt-4.1-mini");
    expect(resolveRequestedModelIdForChannel(channel, "GLM 5")).toBe("zai/glm-5");
    expect(resolveRequestedModelIdForChannel(channel, undefined)).toBe("openai/gpt-4.1-mini");
    expect(resolveChannelDefaultModelId(channel)).toBe("openai/gpt-4.1-mini");
    expect(resolveModelCandidatesForChannel(channel, "mini")).toEqual([
      "openai/gpt-4.1-mini",
      "zai/glm-5"
    ]);
  });

  test("resolveAgentDefaultStrategy 应优先使用 thread override", () => {
    expect(resolveAgentDefaultStrategy({
      thread: {
        channelId: "thread-channel",
        modelRef: "thread/model",
      },
      globalDefault: {
        defaultChannelId: "global-channel",
        defaultModelRef: "global/model",
        fallbackModelRefs: ["global/fallback-1", "global/fallback-2"],
      }
    })).toEqual({
      source: "thread-override",
      channelId: "thread-channel",
      modelRef: "thread/model",
      fallbackModelRefs: ["global/fallback-1", "global/fallback-2"],
    });
  });

  test("resolveAgentDefaultStrategy 应将 partial thread override 与 global default 合并", () => {
    expect(resolveAgentDefaultStrategy({
      thread: {
        channelId: "thread-channel",
        modelRef: " ",
      },
      globalDefault: {
        defaultChannelId: "global-channel",
        defaultModelRef: "global/model",
        fallbackModelRefs: ["global/fallback-1"],
      }
    })).toEqual({
      source: "thread-override",
      channelId: "thread-channel",
      modelRef: "global/model",
      fallbackModelRefs: ["global/fallback-1"],
    });

    expect(resolveAgentDefaultStrategy({
      thread: {
        channelId: "",
        modelRef: "thread/model",
      },
      globalDefault: {
        defaultChannelId: "global-channel",
        defaultModelRef: "global/model",
        fallbackModelRefs: ["global/fallback-1"],
      }
    })).toEqual({
      source: "thread-override",
      channelId: "global-channel",
      modelRef: "thread/model",
      fallbackModelRefs: ["global/fallback-1"],
    });
  });

  test("resolveAgentDefaultStrategy 应在无 thread override 时回退到 global default", () => {
    expect(resolveAgentDefaultStrategy({
      thread: {
        channelId: "   ",
        modelRef: "",
      },
      globalDefault: {
        defaultChannelId: "global-channel",
        defaultModelRef: "global/model",
        fallbackModelRefs: ["global/fallback-1", " ", "global/fallback-2", "global/fallback-1"],
      }
    })).toEqual({
      source: "global-default",
      channelId: "global-channel",
      modelRef: "global/model",
      fallbackModelRefs: ["global/fallback-1", "global/fallback-2"],
    });
  });

  test("resolveAgentDefaultStrategy 应在 thread selection 缺失时继承 global default", () => {
    expect(resolveAgentDefaultStrategy({
      globalDefault: {
        defaultChannelId: "global-channel",
        defaultModelRef: "global/model",
        fallbackModelRefs: ["global/fallback-1", "global/fallback-1", " "],
      }
    })).toEqual({
      source: "global-default",
      channelId: "global-channel",
      modelRef: "global/model",
      fallbackModelRefs: ["global/fallback-1"],
    });
  });

  test("createAgentThread 在无显式选择时应返回当前全局默认并标记为 inherited", async () => {
    const { updateLumeConfigSection } = await import("../system/lume-config-service");
    const { createAgentThread, getAgentThreadMeta } = await import("../agent/agent-thread-manager");

    updateLumeConfigSection({
      source: "user",
      path: "models.agent",
      value: {
        defaultChannelId: "global-channel",
        defaultModelRef: "openai/gpt-5",
        fallbackModelRefs: ["openai/gpt-5-mini"]
      }
    });

    const created = createAgentThread("inherits defaults");
    const persisted = getAgentThreadMeta(created.id);

    expect(created.channelId).toBe("global-channel");
    expect(created.modelRef).toBe("openai/gpt-5");
    expect(created.modelId).toBeUndefined();
    expect(created.modelSelectionSource).toBe("inherited");
    expect(persisted?.channelId).toBe("global-channel");
    expect(persisted?.modelRef).toBe("openai/gpt-5");
    expect(persisted?.modelId).toBeUndefined();
    expect(persisted?.modelSelectionSource).toBe("inherited");
  });

  test("update-thread-model-selection clear 路径应恢复 inherited 模式", async () => {
    const { createAgentHandlers } = await import("../../rpc/agent-handlers");
    const { agentUpdateThreadModelSelectionInputSchema } = await import("../../rpc/schemas");
    const { validateInput } = await import("../../rpc/validation");
    const { updateLumeConfigSection } = await import("../system/lume-config-service");
    const { createAgentThread, getAgentThreadMeta } = await import("../agent/agent-thread-manager");

    updateLumeConfigSection({
      source: "user",
      path: "models.agent",
      value: {
        defaultChannelId: "global-channel",
        defaultModelRef: "openai/gpt-5"
      }
    });

    const thread = createAgentThread("explicit thread", "channel-1", undefined, undefined, "provider/model-1");
    expect(getAgentThreadMeta(thread.id)?.channelId).toBe("channel-1");
    expect(getAgentThreadMeta(thread.id)?.modelRef).toBe("provider/model-1");
    expect(getAgentThreadMeta(thread.id)?.modelSelectionSource).toBe("thread-override");

    const parsed = validateInput(agentUpdateThreadModelSelectionInputSchema, {
      threadId: thread.id,
      modelRef: null,
      channelId: null,
      modelId: null
    }, AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION);

    expect(parsed.modelRef).toBeNull();
    expect(parsed.channelId).toBeNull();
    expect(parsed.modelId).toBeNull();

    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: {
        isLikelyExecutionRequest: () => false,
        getPhase: () => "idle",
        clearSession: () => undefined
      } as any,
      notifyPlanStateChange: () => undefined
    });

    const updated = await handlers[AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION]!({
      threadId: thread.id,
      modelRef: null,
      channelId: null,
      modelId: null
    }) as {
      modelRef?: string;
      channelId?: string;
      modelId?: string;
      modelSelectionSource?: "inherited" | "thread-override";
    };

    expect(updated.modelRef).toBe("openai/gpt-5");
    expect(updated.channelId).toBe("global-channel");
    expect(updated.modelId).toBeUndefined();
    expect(updated.modelSelectionSource).toBe("inherited");
    expect(getAgentThreadMeta(thread.id)?.modelRef).toBe("openai/gpt-5");
    expect(getAgentThreadMeta(thread.id)?.channelId).toBe("global-channel");
    expect(getAgentThreadMeta(thread.id)?.modelId).toBeUndefined();
    expect(getAgentThreadMeta(thread.id)?.modelSelectionSource).toBe("inherited");
  });

  test("update-thread-model-selection 部分更新时不应清空未提供的字段，也不应在空 payload 下切换来源", async () => {
    const { createAgentHandlers } = await import("../../rpc/agent-handlers");
    const { createAgentThread, getAgentThreadMeta } = await import("../agent/agent-thread-manager");

    const thread = createAgentThread("partial update", "channel-1", undefined, undefined, "provider/model-1");
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: {
        isLikelyExecutionRequest: () => false,
        getPhase: () => "idle",
        clearSession: () => undefined
      } as any,
      notifyPlanStateChange: () => undefined
    });

    const partialUpdated = await handlers[AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION]!({
      threadId: thread.id,
      modelRef: "provider/model-2"
    }) as {
      modelRef?: string;
      channelId?: string;
      modelId?: string;
      modelSelectionSource?: "inherited" | "thread-override";
    };

    expect(partialUpdated.modelRef).toBe("provider/model-2");
    expect(partialUpdated.channelId).toBe("channel-1");
    expect(partialUpdated.modelId).toBe("provider/model-1");
    expect(partialUpdated.modelSelectionSource).toBe("thread-override");

    const afterPartial = getAgentThreadMeta(thread.id);
    expect(afterPartial?.modelRef).toBe("provider/model-2");
    expect(afterPartial?.channelId).toBe("channel-1");
    expect(afterPartial?.modelId).toBe("provider/model-1");
    expect(afterPartial?.modelSelectionSource).toBe("thread-override");

    const noOpUpdated = await handlers[AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION]!({
      threadId: thread.id
    }) as {
      modelRef?: string;
      channelId?: string;
      modelId?: string;
      modelSelectionSource?: "inherited" | "thread-override";
    };

    expect(noOpUpdated.modelRef).toBe("provider/model-2");
    expect(noOpUpdated.channelId).toBe("channel-1");
    expect(noOpUpdated.modelId).toBe("provider/model-1");
    expect(noOpUpdated.modelSelectionSource).toBe("thread-override");
  });

  test("sendAgentMessage 在 inherited 模式下应使用当前全局默认且不转换为 override", async () => {
    const { updateLumeConfigSection } = await import("../system/lume-config-service");
    const { createChannel } = await import("./channel-manager");
    const { createAgentThread, getAgentThreadMeta } = await import("../agent/agent-thread-manager");
    const { sendAgentMessage } = await import("../agent/agent-service");

    const oldChannel = createChannel({
      name: "Old OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      enabled: true,
      models: [{
        id: "gpt-5",
        name: "GPT-5",
        enabled: true,
        capabilities: { chat: true }
      }],
      defaultModelId: "gpt-5"
    });
    const newChannel = createChannel({
      name: "New OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key-2",
      enabled: true,
      models: [{
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        enabled: true,
        capabilities: { chat: true }
      }],
      defaultModelId: "gpt-5-mini"
    });

    updateLumeConfigSection({
      source: "user",
      path: "models.agent",
      value: {
        defaultChannelId: oldChannel.id,
        defaultModelRef: "openai/gpt-5",
        fallbackModelRefs: ["openai/gpt-5-mini"]
      }
    });

    const thread = createAgentThread("runtime inheritance");
    expect(getAgentThreadMeta(thread.id)?.modelRef).toBe("openai/gpt-5");
    expect(getAgentThreadMeta(thread.id)?.channelId).toBe(oldChannel.id);
    expect(getAgentThreadMeta(thread.id)?.modelId).toBeUndefined();
    expect(getAgentThreadMeta(thread.id)?.modelSelectionSource).toBe("inherited");

    updateLumeConfigSection({
      source: "user",
      path: "models.agent",
      value: {
        defaultChannelId: newChannel.id,
        defaultModelRef: "openai/gpt-5-mini"
      }
    });

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "hello inherited runtime"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const persisted = getAgentThreadMeta(thread.id);
    expect(capturedRuntimeCalls).toHaveLength(1);
    expect(capturedRuntimeCalls[0]?.input?.channelId).toBe(newChannel.id);
    expect(capturedRuntimeCalls[0]?.input?.modelId).toBe("gpt-5-mini");
    expect(capturedRuntimeCalls[0]?.runtime?.modelRef).toBe("openai/gpt-5-mini");
    expect(capturedRuntimeCalls[0]?.runtime?.channelId).toBe(newChannel.id);
    expect(persisted?.modelRef).toBe("openai/gpt-5");
    expect(persisted?.channelId).toBe(oldChannel.id);
    expect(persisted?.modelId).toBeUndefined();
    expect(persisted?.modelSelectionSource).toBe("inherited");
  });

  test("sendAgentMessage 显式覆盖持久化时应写入本次运行实际使用的完整选择", async () => {
    const { createChannel } = await import("./channel-manager");
    const { createAgentThread, getAgentThreadMeta } = await import("../agent/agent-thread-manager");
    const { sendAgentMessage } = await import("../agent/agent-service");

    const channel = createChannel({
      name: "Override OpenAI",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "override-key",
      enabled: true,
      models: [{
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        enabled: true,
        capabilities: { chat: true }
      }],
      defaultModelId: "gpt-5-mini"
    });

    const thread = createAgentThread("send explicit override");

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "hello explicit override",
      modelRef: "openai/gpt-5-mini"
    }, {
      onMessageAppended: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    expect(capturedRuntimeCalls.at(-1)?.input?.channelId).toBe(channel.id);
    expect(capturedRuntimeCalls.at(-1)?.input?.modelId).toBe("gpt-5-mini");
    expect(capturedRuntimeCalls.at(-1)?.runtime?.modelRef).toBe("openai/gpt-5-mini");
    expect(capturedRuntimeCalls.at(-1)?.runtime?.channelId).toBe(channel.id);

    const persisted = getAgentThreadMeta(thread.id);
    expect(persisted?.modelRef).toBe("openai/gpt-5-mini");
    expect(persisted?.channelId).toBe(channel.id);
    expect(persisted?.modelId).toBe("gpt-5-mini");
    expect(persisted?.modelSelectionSource).toBe("thread-override");
  });

  test("resolveAgentDefaultStrategy 应在无可用值时返回 empty", () => {
    expect(resolveAgentDefaultStrategy({
      thread: {
        channelId: " ",
        modelRef: " ",
      },
      globalDefault: {
        defaultChannelId: " ",
        defaultModelRef: " ",
        fallbackModelRefs: [" ", ""],
      }
    })).toEqual({
      source: "empty",
      channelId: undefined,
      modelRef: undefined,
      fallbackModelRefs: [],
    });
  });
});
