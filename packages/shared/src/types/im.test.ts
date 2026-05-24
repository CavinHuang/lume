import { describe, expect, test } from "bun:test";
import { IM_IPC_CHANNELS, normalizeImAccountLabel } from "./im";

describe("im shared types", () => {
  test("IM IPC channel names are stable", () => {
    expect(IM_IPC_CHANNELS.LIST_ACCOUNTS).toBe("im:list-accounts");
    expect(IM_IPC_CHANNELS.CREATE_ACCOUNT).toBe("im:create-account");
    expect(IM_IPC_CHANNELS.UPDATE_ACCOUNT).toBe("im:update-account");
    expect(IM_IPC_CHANNELS.DELETE_ACCOUNT).toBe("im:delete-account");
    expect(IM_IPC_CHANNELS.START_ACCOUNT).toBe("im:start-account");
    expect(IM_IPC_CHANNELS.STOP_ACCOUNT).toBe("im:stop-account");
  });

  test("normalizeImAccountLabel falls back to provider label", () => {
    expect(normalizeImAccountLabel({ provider: "weixin", label: "  " })).toBe("Weixin");
  });
});
