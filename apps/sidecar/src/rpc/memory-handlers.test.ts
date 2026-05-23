import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MEMORY_IPC_CHANNELS,
  type MemoryIngestSourcesJob,
  type MemoryOrganizeEntriesResult,
  type MemoryStartIngestSourcesResult
} from "@lume/shared";
import { createAgentThread, appendAgentTranscriptMessage } from "../services/agent/agent-thread-manager";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createMemoryV2Store } from "../services/memory-v2/markdown-store";
import { createMemoryHandlers } from "./memory-handlers";

let root: string;
const GET_INGEST_JOB = "memory:get-ingest-job";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-rpc-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("memory handlers", () => {
  test("settings snapshot handler reads Memory V2 state", async () => {
    createMemoryV2Store().writeEntry({
      kind: "preference",
      targetScope: "workspace",
      statement: "Memory settings page reads V2 markdown directly.",
      confidence: "high",
      appliesWhen: {
        workspaceSlug: "demo"
      }
    });

    const handlers = createMemoryHandlers();
    const result = await handlers[MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT]?.({
      workspaceSlug: "demo"
    });

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      counts: {
        workspace: 1
      }
    });
  });

  test("organize history handler extracts memories from existing thread data", async () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("memory history", undefined, workspace.id);
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-user-1",
      role: "user",
      content: "叫我 Mason",
      createdAt: 100
    });

    const handlers = createMemoryHandlers();
    const result = await handlers[MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY]?.({
      workspaceSlug: "demo",
      limit: 20
    });

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      scannedMessages: 1,
      candidateCount: 1,
      actions: {
        new: 1
      }
    });
  });

  test("organize entries handler supersedes duplicate historical memories", async () => {
    const store = createMemoryV2Store();
    const kept = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as the source of truth.",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });
    const duplicate = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as source of truth",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });

    const handlers = createMemoryHandlers();
    const result = await handlers[MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES]?.({
      workspaceSlug: "demo"
    }) as MemoryOrganizeEntriesResult;

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      scannedEntries: 2,
      keptEntries: 1,
      supersededDuplicates: 1
    });
    expect(new Set([
      result.items[0]?.keptId,
      result.items[0]?.duplicateId
    ])).toEqual(new Set([
      kept.frontmatter.id,
      duplicate.frontmatter.id
    ]));
  });

  test("ingest sources handler starts a background job for pasted text imports", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });

    const handlers = createMemoryHandlers();
    const started = await handlers[MEMORY_IPC_CHANNELS.INGEST_SOURCES]?.({
      workspaceSlug: "demo",
      sources: [{
        kind: "pasted_text",
        title: "称呼偏好",
        content: "叫我 Mason",
        targetScope: "global"
      }]
    }) as MemoryStartIngestSourcesResult;

    const jobId = started.jobId;
    expect(typeof jobId).toBe("string");
    expect(started).toMatchObject({
      workspaceSlug: "demo",
      status: "running",
      jobId: expect.any(String)
    });

    const job = await waitForIngestJob(handlers, jobId);
    expect(job).toMatchObject({
      workspaceSlug: "demo",
      status: "completed",
      result: {
        workspaceSlug: "demo",
        scannedSources: 1,
        scannedChunks: 1,
        scannedBatches: 1,
        candidateCount: 1,
        actions: {
          new: 1
        }
      }
    });
  });

  test("ingest sources job reports failures without throwing during start", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });

    const handlers = createMemoryHandlers();
    const started = await handlers[MEMORY_IPC_CHANNELS.INGEST_SOURCES]?.({
      workspaceSlug: "demo",
      sources: [{
        kind: "local_file",
        path: join(root, "missing.md")
      }]
    }) as MemoryStartIngestSourcesResult;

    const jobId = started.jobId;
    expect(typeof jobId).toBe("string");
    expect(started).toMatchObject({
      workspaceSlug: "demo",
      status: "running",
      jobId: expect.any(String)
    });

    const job = await waitForIngestJob(handlers, jobId);
    expect(job).toMatchObject({
      workspaceSlug: "demo",
      status: "failed",
      error: expect.stringContaining("本地文件不存在")
    });
  });

  test("ingest sources handler imports selected local text files through a background job", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const filePath = join(root, "external", "name.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "叫我 Mason", "utf-8");

    const handlers = createMemoryHandlers();
    const started = await handlers[MEMORY_IPC_CHANNELS.INGEST_SOURCES]?.({
      workspaceSlug: "demo",
      sources: [{
        kind: "local_file",
        path: filePath
      }]
    }) as MemoryStartIngestSourcesResult;
    const job = await waitForIngestJob(handlers, started.jobId);

    expect(job).toMatchObject({
      workspaceSlug: "demo",
      status: "completed",
      result: {
        scannedSources: 1,
        scannedChunks: 1,
        scannedBatches: 1,
        candidateCount: 1,
        actions: {
          new: 1
        }
      }
    });
  });

  test("ingest sources handler imports selected local folders through a background job", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const folderPath = join(root, "external-folder");
    const filePath = join(folderPath, "name.md");
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(filePath, "叫我 Mason", "utf-8");

    const handlers = createMemoryHandlers();
    const started = await handlers[MEMORY_IPC_CHANNELS.INGEST_SOURCES]?.({
      workspaceSlug: "demo",
      sources: [{
        kind: "local_folder",
        path: folderPath
      }]
    }) as MemoryStartIngestSourcesResult;
    const job = await waitForIngestJob(handlers, started.jobId);

    expect(job).toMatchObject({
      workspaceSlug: "demo",
      status: "completed",
      result: {
        scannedSources: 1,
        scannedChunks: 1,
        scannedBatches: 1,
        candidateCount: 1,
        actions: {
          new: 1
        }
      }
    });
  });
});

async function waitForIngestJob(
  handlers: ReturnType<typeof createMemoryHandlers>,
  jobId: string
) : Promise<MemoryIngestSourcesJob> {
  const getJob = handlers[GET_INGEST_JOB];
  expect(getJob).toBeDefined();
  if (!getJob) throw new Error("missing ingest job handler");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = await getJob({ jobId }) as MemoryIngestSourcesJob;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ingest job did not finish");
}
