import { describe, expect, test } from "bun:test";
import { IM_IPC_CHANNELS, IM_PROVIDER_LABELS, normalizeImAccountLabel } from "./im";

describe("im shared types", () => {
  test("IM IPC channel names are stable", () => {
    expect(IM_IPC_CHANNELS.LIST_ACCOUNTS).toBe("im:list-accounts");
    expect(IM_IPC_CHANNELS.CREATE_ACCOUNT).toBe("im:create-account");
    expect(IM_IPC_CHANNELS.UPDATE_ACCOUNT).toBe("im:update-account");
    expect(IM_IPC_CHANNELS.DELETE_ACCOUNT).toBe("im:delete-account");
    expect(IM_IPC_CHANNELS.START_ACCOUNT).toBe("im:start-account");
    expect(IM_IPC_CHANNELS.STOP_ACCOUNT).toBe("im:stop-account");
    expect(IM_IPC_CHANNELS.START_WEIXIN_LOGIN).toBe("im:start-weixin-login");
    expect(IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN).toBe("im:poll-weixin-login");
  });

  test("IM_PROVIDER_LABELS 覆盖所有 ImProvider", () => {
    const providers = ["weixin", "dingtalk", "feishu", "wecom"] as const;
    for (const p of providers) {
      expect(IM_PROVIDER_LABELS[p]).toBeTruthy();
    }
  });

  test("normalizeImAccountLabel falls back to provider label", () => {
    expect(normalizeImAccountLabel({ provider: "weixin", label: "  " })).toBe("微信");
    expect(normalizeImAccountLabel({ provider: "dingtalk", label: "" })).toBe("钉钉");
  });
});
