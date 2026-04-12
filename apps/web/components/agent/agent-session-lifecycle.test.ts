import { describe, expect, test } from "bun:test";
import type { AgentThreadMeta, Channel } from "@lume/shared";
import { resolvePreferredAgentSelection } from "./agent-session-lifecycle";

describe("agent-session-lifecycle", () => {
  test("resolvePreferredAgentSelection 应优先使用当前会话绑定且启用的 channel/model", () => {
    const channels: Channel[] = [
      {
        id: "channel-a",
        name: "A",
        provider: "openai",
        enabled: true,
        models: [
          { id: "a-disabled", name: "A Disabled", enabled: false },
          { id: "a-model", name: "A Model", enabled: true }
        ],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "channel-b",
        name: "B",
        provider: "openai",
        enabled: true,
        defaultModelId: "b-model",
        models: [
          { id: "b-model", name: "B Model", enabled: true }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Channel[];

    const thread: AgentThreadMeta = {
      id: "session-1",
      title: "Session",
      channelId: "channel-b",
      modelId: "b-model",
      createdAt: 1,
      updatedAt: 1
    };

    expect(resolvePreferredAgentSelection({
      channels,
      thread,
      currentChannelId: "channel-a",
      currentModelId: "a-model"
    })).toEqual({
      channelId: "channel-b",
      modelId: "b-model"
    });
  });

  test("resolvePreferredAgentSelection 应在会话模型失效时回退到当前已选模型，再回退默认启用模型", () => {
    const channels: Channel[] = [
      {
        id: "channel-a",
        name: "A",
        provider: "openai",
        enabled: true,
        defaultModelId: "a-default",
        models: [
          { id: "a-disabled", name: "A Disabled", enabled: false },
          { id: "a-current", name: "A Current", enabled: true },
          { id: "a-default", name: "A Default", enabled: true }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Channel[];

    const thread: AgentThreadMeta = {
      id: "session-1",
      title: "Session",
      channelId: "channel-a",
      modelId: "a-disabled",
      createdAt: 1,
      updatedAt: 1
    };

    expect(resolvePreferredAgentSelection({
      channels,
      thread,
      currentChannelId: "channel-a",
      currentModelId: "a-current"
    })).toEqual({
      channelId: "channel-a",
      modelId: "a-current"
    });

    expect(resolvePreferredAgentSelection({
      channels,
      thread,
      currentChannelId: "channel-a",
      currentModelId: "missing"
    })).toEqual({
      channelId: "channel-a",
      modelId: "a-default"
    });
  });

  test("resolvePreferredAgentSelection 在线程未绑定时应优先使用系统默认 model ref", () => {
    const channels: Channel[] = [
      {
        id: "channel-a",
        name: "A",
        provider: "openai",
        enabled: true,
        models: [
          { id: "gpt-4.1", name: "GPT-4.1", enabled: true, capabilities: { chat: true } }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Channel[];

    expect(resolvePreferredAgentSelection({
      channels,
      thread: null,
      currentChannelId: null,
      currentModelId: null,
      defaultModelRef: "openai/gpt-4.1"
    })).toEqual({
      channelId: "channel-a",
      modelId: "gpt-4.1"
    });
  });

  test("resolvePreferredAgentSelection 应优先使用线程上的 modelRef", () => {
    const channels: Channel[] = [
      {
        id: "channel-a",
        name: "A",
        provider: "openai",
        enabled: true,
        models: [
          { id: "gpt-4.1", name: "GPT-4.1", enabled: true, capabilities: { chat: true } }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Channel[];

    expect(resolvePreferredAgentSelection({
      channels,
      thread: {
        modelRef: "openai/gpt-4.1",
      },
      currentChannelId: null,
      currentModelId: null,
      defaultModelRef: "openai/other-model"
    })).toEqual({
      channelId: "channel-a",
      modelId: "gpt-4.1"
    });
  });
});
