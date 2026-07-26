import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { CodingTurnRecord } from "@lume/shared";
import { createCodingTurnRecord, getCodingTurnRecord, updateCodingTurnRecord } from "./coding-turn-store";

function record(): CodingTurnRecord {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    userMessageId: "user-1",
    runIds: ["run-1"],
    startedAt: new Date(0).toISOString(),
    changedFiles: [],
    verificationStatus: "not_run",
    verificationRepairAttempts: 0,
    approvalRequestCount: 0,
    rewindState: "active",
  };
}

describe("coding turn store", () => {
  test("persists a turn and updates its terminal state atomically", async () => {
    const sessionDir = join(mkdtempSync(join(tmpdir(), "lume-coding-turn-")), "session");
    await createCodingTurnRecord(sessionDir, record());
    const updated = await updateCodingTurnRecord(sessionDir, "turn-1", {
      runIds: ["run-1", "run-2"],
      rewindState: "available",
      finishedAt: new Date(1).toISOString(),
    });

    expect(updated?.runIds).toEqual(["run-1", "run-2"]);
    expect((await getCodingTurnRecord(sessionDir, "turn-1"))?.rewindState).toBe("available");
  });

  test("does not invent a record for a historical turn", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-coding-turn-missing-"));
    await expect(getCodingTurnRecord(sessionDir, "missing")).resolves.toBeNull();
  });
});
