import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumePlanStore } from "./plan-store";

describe("plan-store", () => {
  test("upserts and lists structured plans by thread", async () => {
    const store = createFileBackedLumePlanStore(mkdtempSync(join(tmpdir(), "lume-plan-store-")));
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

    expect((await store.listByThread("thread-1")).map((plan) => plan.id)).toEqual(["plan-1"]);
    expect((await store.get("plan-1"))?.steps[0]?.title).toBe("Read code");
  });
});
