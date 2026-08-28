import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialImRunCardState } from "./feishu-card-state";
import {
  checkpointActiveFeishuCard,
  listActiveFeishuCards,
  registerActiveFeishuCard,
  removeActiveFeishuCard,
  reserveActiveFeishuCardSequenceBlock
} from "./feishu-card-recovery-store";

describe("feishu-card-recovery-store", () => {
  let previousConfigDir: string | undefined;
  let configDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "lume-feishu-card-recovery-"));
    process.env.LUME_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("登记状态、按块预留 sequence、检查点更新并删除", () => {
    const initial = initialImRunCardState(1000);
    expect(registerActiveFeishuCard({
      cardId: "card-1",
      accountId: "account-1",
      chatId: "chat-1",
      state: initial
    })).toBe(true);

    expect(reserveActiveFeishuCardSequenceBlock("card-1")).toEqual({ sequence: 1, ceiling: 1000 });
    expect(reserveActiveFeishuCardSequenceBlock("card-1")).toEqual({ sequence: 1001, ceiling: 2000 });

    const next = { ...initial, blocks: [{ kind: "text" as const, id: "text:m1", text: "结果" }] };
    expect(checkpointActiveFeishuCard("card-1", next)).toBe(true);
    expect(listActiveFeishuCards()).toEqual([expect.objectContaining({
      cardId: "card-1",
      sequenceCeiling: 2000,
      state: next
    })]);

    removeActiveFeishuCard("card-1");
    expect(listActiveFeishuCards()).toEqual([]);
  });
});
