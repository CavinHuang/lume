import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createCodingTurnRecord } from "./coding-turn-store";

describe("coding-turn-store", () => {
  let dir = "";
  let prevConfigDir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
    if (prevConfigDir !== undefined) {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("createCodingTurnRecord 持久化并按 turnId 幂等去重", async () => {
    dir = mkdtempSync(join(tmpdir(), "lume-coding-turns-"));
    const record = {
      turnId: "turn-1",
      threadId: "thread-1",
      userMessageId: "msg-1",
      runIds: ["run-1"],
      startedAt: new Date().toISOString(),
      changedFiles: ["a.ts"],
      verificationRepairAttempts: 0,
      approvalRequestCount: 0,
      rewindState: "none"
    };

    await createCodingTurnRecord(dir, record as never);
    // 同 turnId 重复写入应替换而非追加
    await createCodingTurnRecord(dir, { ...record, runIds: ["run-2"] } as never);

    const { readFileSync } = await import("node:fs");
    const payload = JSON.parse(readFileSync(join(dir, "coding-turns.json"), "utf8")) as {
      version: number;
      turns: Array<{ turnId: string; runIds: string[] }>;
    };
    expect(payload.version).toBe(1);
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]).toMatchObject({ turnId: "turn-1", runIds: ["run-2"] });
  });
});
