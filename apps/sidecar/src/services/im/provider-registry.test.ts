import { describe, it, expect } from "bun:test";
import {
  registerImProvider,
  getImProvider,
  listRegisteredProviders,
  type ImProviderDefinition,
} from "./provider-registry";

const makeDef = (provider: "dingtalk"): ImProviderDefinition => ({
  provider,
  createWorker: () => ({ start() {}, stop() {}, isRunning: () => false }),
  sendText: async () => ({ ok: true }),
});

describe("provider-registry", () => {
  it("注册后可查", () => {
    registerImProvider(makeDef("dingtalk"));
    expect(getImProvider("dingtalk").provider).toBe("dingtalk");
    expect(listRegisteredProviders()).toContain("dingtalk");
  });

  it("重复注册覆盖旧定义", () => {
    registerImProvider(makeDef("dingtalk"));
    const replaced: ImProviderDefinition = {
      ...makeDef("dingtalk"),
      sendText: async () => ({ ok: false }),
    };
    registerImProvider(replaced);
    expect(getImProvider("dingtalk")).toBe(replaced);
  });

  it("未注册 provider 抛错", () => {
    // 用保证永不注册的字符串,避免与正式注册的 provider(weixin/dingtalk/feishu/wecom)耦合
    expect(() => getImProvider("unregistered-provider" as never)).toThrow(/未注册|provider/i);
  });
});
