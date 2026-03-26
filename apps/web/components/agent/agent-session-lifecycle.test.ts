import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentSessionMeta, Channel } from "@lume/shared";
import {
  recoverPlanFromMessages,
  resolvePreferredAgentSelection
} from "./agent-session-lifecycle";

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

    const session: AgentSessionMeta = {
      id: "session-1",
      title: "Session",
      channelId: "channel-b",
      modelId: "b-model",
      createdAt: 1,
      updatedAt: 1
    };

    expect(resolvePreferredAgentSelection({
      channels,
      session,
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

    const session: AgentSessionMeta = {
      id: "session-1",
      title: "Session",
      channelId: "channel-a",
      modelId: "a-disabled",
      createdAt: 1,
      updatedAt: 1
    };

    expect(resolvePreferredAgentSelection({
      channels,
      session,
      currentChannelId: "channel-a",
      currentModelId: "a-current"
    })).toEqual({
      channelId: "channel-a",
      modelId: "a-current"
    });

    expect(resolvePreferredAgentSelection({
      channels,
      session,
      currentChannelId: "channel-a",
      currentModelId: "missing"
    })).toEqual({
      channelId: "channel-a",
      modelId: "a-default"
    });
  });

  test("recoverPlanFromMessages 应恢复 ExitPlanMode 写入的计划路径和草稿内容", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "这是规划草稿",
        createdAt: 100,
        events: [
          {
            type: "tool_result",
            toolUseId: "tool-1",
            toolName: "ExitPlanMode",
            isError: false,
            result: JSON.stringify({
              planPath: "docs/plans/phase-b.md",
              slug: "phase-b"
            })
          }
        ]
      }
    ];

    expect(recoverPlanFromMessages(messages)).toEqual({
      planPath: "docs/plans/phase-b.md",
      draft: "这是规划草稿"
    });
  });
});
