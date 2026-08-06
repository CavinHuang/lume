import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryV2Store } from "./markdown-store";
import { maybeEnqueueAutoDream } from "./consolidation";
import { memoryJobService } from "./job-service";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-consolidation-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("AutoDream consolidation", () => {
  test("requires both the time window and five new completed runs", async () => {
    expect(maybeEnqueueAutoDream("demo")).toBeUndefined();
    const store = createMemoryV2Store();
    for (let index = 0; index < 5; index += 1) {
      store.appendRunArchive({
        workspaceSlug: "demo",
        runId: `run-${index}`,
        record: { type: "run.completed", index }
      });
    }
    const job = maybeEnqueueAutoDream("demo");
    expect(job?.kind).toBe("consolidation");
    const completed = await memoryJobService.waitForTerminal("demo", job!.jobId);
    expect(completed?.status).toBe("completed");
  });
});
