import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedTaskContractStore } from "./task-contract-store";
import {
  importMarkdownTaskContract,
  mapMarkdownTaskContractToRecord
} from "./task-contract-file-mapper";

describe("task-contract-file-mapper", () => {
  test("maps markdown task contract front matter and task list into TaskContractRecord", () => {
    const contract = mapMarkdownTaskContractToRecord({
      runId: "run-1",
      threadId: "thread-1",
      path: "/tmp/plans/demo.md",
      content: [
        "---",
        "summary: \"演示计划\"",
        "slug: demo-plan",
        "status: approved",
        "---",
        "# Ship runtime",
        "",
        "- [x] Read current runtime",
        "- [ ] Extract runner loop",
        "- [ ] Verify tests"
      ].join("\n"),
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(contract.id).toBe("demo-plan");
    expect(contract.goal).toBe("Ship runtime");
    expect(contract.summary).toBe("演示计划");
    expect(contract.status).toBe("approved");
    expect(contract.steps.map((step) => [step.title, step.status])).toEqual([
      ["Read current runtime", "completed"],
      ["Extract runner loop", "pending"],
      ["Verify tests", "pending"]
    ]);
    expect(contract.expectedChanges.files).toEqual(["/tmp/plans/demo.md"]);
  });

  test("imports mapped markdown task contract into store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-contract-import-"));
    try {
      const store = createFileBackedTaskContractStore(dir);
      const contract = await importMarkdownTaskContract(store, {
        runId: "run-1",
        threadId: "thread-1",
        content: "# Plan\n\n1. Inspect\n2. Implement"
      });

      const listed = await store.listByThread("thread-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(contract.id);
      expect(listed[0]?.steps.map((step) => step.title)).toEqual(["Inspect", "Implement"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
