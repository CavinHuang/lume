import { describe, expect, test } from "bun:test";
import type { Channel } from "@lume/shared";
import {
  buildModelOptions,
  filterGroupedModelOptions,
  groupModelOptionsByChannel
} from "./ModelSelector";

const channels: Channel[] = [
  {
    id: "channel-a",
    name: "Z.AI Coding Plan",
    provider: "zai",
    enabled: true,
    apiKey: "",
    models: [
      { id: "glm-4.7", name: "glm-4.7", enabled: true },
      { id: "glm-5", name: "glm-5", enabled: true },
      { id: "disabled-model", name: "disabled-model", enabled: false }
    ],
    createdAt: 1,
    updatedAt: 1,
    defaultModelId: "glm-4.7"
  },
  {
    id: "channel-b",
    name: "OpenAI",
    provider: "openai",
    enabled: true,
    apiKey: "",
    models: [
      { id: "gpt-5", name: "gpt-5", enabled: true }
    ],
    createdAt: 1,
    updatedAt: 1
  }
] as Channel[];

describe("model-selector", () => {
  test("buildModelOptions 应忽略禁用模型并优先默认模型", () => {
    const options = buildModelOptions(channels);

    expect(options.map((item) => item.modelId)).toEqual(["glm-4.7", "glm-5", "gpt-5"]);
    expect(options[0]?.isDefault).toBeTrue();
  });

  test("groupModelOptionsByChannel 应按 channelId 分组", () => {
    const grouped = groupModelOptionsByChannel(buildModelOptions(channels));

    expect(grouped.get("channel-a")?.length).toBe(2);
    expect(grouped.get("channel-b")?.length).toBe(1);
  });

  test("filterGroupedModelOptions 应按模型名和渠道名过滤", () => {
    const grouped = groupModelOptionsByChannel(buildModelOptions(channels));

    expect(filterGroupedModelOptions(grouped, "glm").get("channel-a")?.length).toBe(2);
    expect(filterGroupedModelOptions(grouped, "openai").get("channel-b")?.length).toBe(1);
    expect(filterGroupedModelOptions(grouped, "missing").size).toBe(0);
  });
});
