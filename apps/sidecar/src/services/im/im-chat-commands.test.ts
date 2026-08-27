import { describe, expect, test } from "bun:test";
import type { Channel } from "@lume/shared";
import {
  formatChannelListText,
  formatImHelpText,
  formatImNowText,
  formatModelListText,
  parseImCommand,
  resolveImModelSwitch
} from "./im-chat-commands";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "ch-1",
    name: "OpenAI",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    enabled: true,
    models: [
      { id: "gpt-5-mini", name: "GPT-5 mini", enabled: true },
      { id: "gpt-5", name: "GPT-5", enabled: true }
    ],
    defaultModelId: "gpt-5-mini",
    ...overrides
  } as Channel;
}

describe("parseImCommand", () => {
  test("识别命令与单字母别名", () => {
    expect(parseImCommand("/help")).toEqual({ type: "help" });
    expect(parseImCommand("/h")).toEqual({ type: "help" });
    expect(parseImCommand("/stop")).toEqual({ type: "stop" });
    expect(parseImCommand("/s")).toEqual({ type: "stop" });
    expect(parseImCommand("/now")).toEqual({ type: "now" });
    expect(parseImCommand("/n")).toEqual({ type: "now" });
    expect(parseImCommand("/new")).toEqual({ type: "new" });
  });

  test("model 带参数解析；@bot 后缀与大小写归一", () => {
    expect(parseImCommand("/model")).toEqual({ type: "model", args: [] });
    expect(parseImCommand("/MODEL 2")).toEqual({ type: "model", args: ["2"] });
    expect(parseImCommand("/m 2 3")).toEqual({ type: "model", args: ["2", "3"] });
    expect(parseImCommand("/stop@my_bot")).toEqual({ type: "stop" });
  });

  test("/revert 携带 runId 参数解析(#714)", () => {
    expect(parseImCommand("/revert")).toEqual({ type: "revert", args: [] });
    expect(parseImCommand("/revert run-abc123")).toEqual({ type: "revert", args: ["run-abc123"] });
    expect(parseImCommand("/Revert@bot run-1")).toEqual({ type: "revert", args: ["run-1"] });
    expect(formatImHelpText()).toContain("/revert");
  });

  test("非命令与未知斜杠返回 none", () => {
    expect(parseImCommand("你好世界")).toEqual({ type: "none" });
    expect(parseImCommand("/etc/hosts 是什么")).toEqual({ type: "none" });
    expect(parseImCommand("")).toEqual({ type: "none" });
  });

  test("无参命令带多余参数报 invalid", () => {
    const parsed = parseImCommand("/stop now please");
    expect(parsed).toMatchObject({ type: "invalid" });
  });
});

describe("格式化与切换解析", () => {
  const channels = [
    channel(),
    channel({ id: "ch-2", name: "Anthropic", provider: "anthropic", enabled: false }),
    channel({
      id: "ch-3",
      name: "DeepSeek",
      provider: "deepseek",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat", enabled: true }]
    })
  ];

  test("渠道列表只列启用项且编号 1 起始", () => {
    const text = formatChannelListText(channels);
    expect(text).toContain("1. OpenAI");
    expect(text).toContain("2. DeepSeek");
    expect(text).not.toContain("Anthropic");
  });

  test("空渠道列表给出引导文案", () => {
    expect(formatChannelListText([])).toContain("暂无启用");
    expect(formatImHelpText()).toContain("/model");
  });

  test("模型列表标注默认模型", () => {
    const text = formatModelListText(channels[0]!);
    expect(text).toContain("1. GPT-5 mini（默认）");
    expect(text).toContain("2. GPT-5");
  });

  test("resolveImModelSwitch：合法切换返回 channel+modelRef", () => {
    const result = resolveImModelSwitch(channels, ["1", "2"]);
    expect(result).toMatchObject({
      ok: true,
      channelId: "ch-1",
      modelId: "gpt-5",
      modelRef: "openai/gpt-5"
    });
  });

  test("resolveImModelSwitch：缺模型参数时回模型列表，序号越界给范围提示", () => {
    const list = resolveImModelSwitch(channels, ["1"]);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.message).toContain("GPT-5");
    const bad = resolveImModelSwitch(channels, ["9", "1"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("序号无效");
  });
});

describe("formatImNowText", () => {
  test("线程覆盖模型显示渠道名；未配置显示跟随全局", () => {
    const withOverride = formatImNowText({
      peerKind: "dm",
      meta: { title: "飞书: 张三", channelId: "ch-1", modelRef: "openai/gpt-5" },
      channels: [channel()]
    });
    expect(withOverride).toContain("任务: 飞书: 张三");
    expect(withOverride).toContain("模型: gpt-5（渠道「OpenAI」）");

    const withoutOverride = formatImNowText({ peerKind: "group", meta: null, channels: [] });
    expect(withoutOverride).toContain("模型: 跟随全局默认");
  });

  test("已删除渠道降级标注", () => {
    const text = formatImNowText({
      peerKind: "dm",
      meta: { title: "旧任务", channelId: "gone", modelRef: "openai/gpt-5" },
      channels: []
    });
    expect(text).toContain("（原渠道已删除）");
  });
});
