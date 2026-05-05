import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedTaskContractStore } from "./task-contract-store";

describe("task-contract-store", () => {
  test("upserts and lists task contracts by thread", async () => {
    const store = createFileBackedTaskContractStore(mkdtempSync(join(tmpdir(), "lume-task-contract-store-")));
    await store.upsert({
      id: "plan-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Clean runtime",
      summary: "Refactor safely",
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: "step-1",
        title: "Read code",
        description: "Inspect runtime",
        type: "read",
        status: "pending"
      }],
      expectedChanges: {
        files: ["apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts"]
      },
      status: "draft",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    expect((await store.listByThread("thread-1")).map((contract) => contract.id)).toEqual(["plan-1"]);
    expect((await store.get("plan-1"))?.steps[0]?.title).toBe("Read code");
  });
});
