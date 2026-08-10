import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgentThread } from "../agent/agent-thread-manager";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
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
  test("counts five distinct private main threads instead of run files", async () => {
    expect(maybeEnqueueAutoDream("demo")).toBeUndefined();
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const store = createMemoryV2Store();
    const repeated = createAgentThread("Repeated", undefined, workspace.id);
    for (let index = 0; index < 5; index += 1) {
      store.appendRunArchive({
        workspaceSlug: "demo",
        runId: `repeated-${index}`,
        record: {
          type: "run.completed",
          threadId: repeated.id,
          threadType: "main",
          chatType: "private",
          createdAt: new Date(Date.now() - 20_000 + index).toISOString()
        }
      });
    }
    expect(maybeEnqueueAutoDream("demo")).toBeUndefined();

    for (let index = 0; index < 5; index += 1) {
      const thread = createAgentThread(`Thread ${index}`, undefined, workspace.id);
      store.appendRunArchive({
        workspaceSlug: "demo",
        runId: `run-${index}`,
        record: {
          type: "run.completed",
          threadId: thread.id,
          threadType: "main",
          chatType: "private",
          createdAt: new Date(Date.now() - 10_000 + index).toISOString()
        }
      });
    }
    const job = maybeEnqueueAutoDream("demo");
    expect(job?.kind).toBe("consolidation");
    memoryJobService.cancel("demo", job!.jobId);
    await memoryJobService.waitForSettled();
  });
});
