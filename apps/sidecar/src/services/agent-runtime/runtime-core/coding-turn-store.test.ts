import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CodingTurnRecord } from "@lume/shared";
import { createCodingTurnRecord } from "./coding-turn-store";

function makeRecord(turnId: string): CodingTurnRecord {
  return {
    turnId,
    threadId: "thread-1",
    userMessageId: `msg-${turnId}`,
    runIds: [`run-${turnId}`],
    startedAt: new Date().toISOString(),
    changedFiles: [{ path: "a.ts", status: "modified" }],
    verificationStatus: "not_run",
    verificationRepairAttempts: 0,
    approvalRequestCount: 0,
    rewindState: "unavailable"
  };
}

describe("coding-turn-store", () => {
  let dir = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  test("createCodingTurnRecord 持久化并按 turnId 幂等去重", async () => {
    dir = mkdtempSync(join(tmpdir(), "lume-coding-turns-"));
    await createCodingTurnRecord(dir, makeRecord("turn-1"));
    // 同 turnId 重复写入应替换而非追加
    await createCodingTurnRecord(dir, { ...makeRecord("turn-1"), runIds: ["run-2"] });

    const payload = JSON.parse(readFileSync(join(dir, "coding-turns.json"), "utf8")) as {
      version: number;
      turns: Array<{ turnId: string; runIds: string[] }>;
    };
    expect(payload.version).toBe(1);
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]).toMatchObject({ turnId: "turn-1", runIds: ["run-2"] });
  });

  test("读取时过滤畸形记录（isCodingTurnRecord 校验路径）", async () => {
    dir = mkdtempSync(join(tmpdir(), "lume-coding-turns-"));
    const good = makeRecord("turn-good");
    const malformed = {
      turnId: "turn-bad",
      threadId: 42, // 非法：应为 string
      userMessageId: "msg-bad",
      runIds: "not-an-array", // 非法：应为数组
      startedAt: new Date().toISOString(),
      changedFiles: [],
      verificationStatus: "not_run",
      verificationRepairAttempts: 0,
      approvalRequestCount: 0,
      rewindState: "unavailable"
    };
    writeFileSync(
      join(dir, "coding-turns.json"),
      JSON.stringify({ version: 1, turns: [good, malformed] }),
      "utf-8"
    );

    await createCodingTurnRecord(dir, makeRecord("turn-new"));

    const payload = JSON.parse(readFileSync(join(dir, "coding-turns.json"), "utf8")) as {
      turns: Array<{ turnId: string }>;
    };
    // 畸形记录被 isCodingTurnRecord 过滤，合法记录保留，新记录追加
    expect(payload.turns.map((turn) => turn.turnId).sort()).toEqual(["turn-good", "turn-new"]);
  });
});
