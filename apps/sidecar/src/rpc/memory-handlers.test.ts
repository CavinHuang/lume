import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MEMORY_IPC_CHANNELS,
  type MemoryIngestSourcesJob,
  type MemoryOrganizeJob,
  type MemoryOrganizeEntriesResult,
  type MemoryStartIngestSourcesResult,
  type MemoryStartOrganizeJobResult
} from "@lume/shared";
import { createAgentThread, appendAgentTranscriptMessage } from "../services/agent/agent-thread-manager";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createMemoryV2Store, readEntryFile, readPendingFile } from "../services/memory-v2/markdown-store";
import { createMemoryHandlers } from "./memory-handlers";

let root: string;
const GET_INGEST_JOB = "memory:get-ingest-job";
const GET_ORGANIZE_JOB = "memory:get-organize-job";

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
    const started = await handlers[MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY]?.({
      workspaceSlug: "demo",
      limit: 20
    }) as MemoryStartOrganizeJobResult;
    const job = await waitForOrganizeJob(handlers, started?.jobId);
    const result = job.result;

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
    const started = await handlers[MEMORY_IPC_CHANNELS.ORGANIZE_ENTRIES]?.({
      workspaceSlug: "demo"
    }) as MemoryStartOrganizeJobResult;
    const job = await waitForOrganizeJob(handlers, started?.jobId);
    const result = job.result as MemoryOrganizeEntriesResult;

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

  test("settings handlers update and recoverably archive memory entries", async () => {
    const store = createMemoryV2Store();
    const entry = store.writeEntry({
      kind: "preference",
      targetScope: "workspace",
      statement: "用户喜欢简短回复",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });

    const handlers = createMemoryHandlers();
    const updated = await handlers[MEMORY_IPC_CHANNELS.UPDATE_ENTRY]?.({
      workspaceSlug: "demo",
      scope: "workspace",
      id: entry.frontmatter.id,
      statement: "用户喜欢直接但有温度的回复",
      confidence: "medium",
      tags: ["style", "manual"]
    });

    expect(updated).toMatchObject({
      ok: true,
      id: entry.frontmatter.id,
      path: entry.path
    });
    expect(readEntryFile(entry.path).statement).toBe("用户喜欢直接但有温度的回复");
    expect(readEntryFile(entry.path).frontmatter.tags).toEqual(["style", "manual"]);

    const deleted = await handlers[MEMORY_IPC_CHANNELS.DELETE_ENTRY]?.({
      workspaceSlug: "demo",
      scope: "workspace",
      id: entry.frontmatter.id
    });

    expect(deleted).toMatchObject({
      ok: true,
      id: entry.frontmatter.id,
      path: entry.path
    });
    expect(existsSync(entry.path)).toBe(true);
    expect(createMemoryV2Store().listEntries({
      workspaceSlug: "demo",
      scopes: ["workspace"],
      includeStatuses: ["archived"]
    }).some((item) => item.frontmatter.id === entry.frontmatter.id)).toBe(true);
  });

  test("settings handler accepts pending conflicts without exposing an agent delete tool", async () => {
    const store = createMemoryV2Store();
    const existing = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      confidence: "high",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    });
    const pending = store.writePending({
      type: "conflict",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Alice",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      },
      existingIds: [existing.frontmatter.id],
      reason: "称呼偏好变化"
    });

    const handlers = createMemoryHandlers();
    const accepted = await handlers[MEMORY_IPC_CHANNELS.RESOLVE_PENDING]?.({
      workspaceSlug: "demo",
      path: pending.path,
      action: "accept",
      candidateOverride: {
        statement: "用户希望在演示时被称呼为 Alice",
        kind: "summary",
        confidence: "medium",
        tags: ["profile", "reviewed"]
      }
    });

    expect(accepted).toMatchObject({
      ok: true,
      path: pending.path
    });
    expect(readPendingFile(pending.path).frontmatter.status).toBe("resolved");
    expect(readEntryFile(existing.path).frontmatter.status).toBe("superseded");
    const acceptedEntry = createMemoryV2Store()
      .listEntries({ scopes: ["global"], includeStatuses: ["active"] })
      .find((entry) => entry.statement === "用户希望在演示时被称呼为 Alice");
    expect(acceptedEntry?.frontmatter.kind).toBe("state");
    expect(acceptedEntry?.frontmatter.tags).toEqual(["profile", "reviewed"]);
    expect(MEMORY_IPC_CHANNELS).not.toHaveProperty("AGENT_DELETE_ENTRY");
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

async function waitForOrganizeJob(
  handlers: ReturnType<typeof createMemoryHandlers>,
  jobId: unknown
) : Promise<MemoryOrganizeJob> {
  expect(typeof jobId).toBe("string");
  if (typeof jobId !== "string") throw new Error("organize job did not start");
  const getJob = handlers[GET_ORGANIZE_JOB];
  expect(getJob).toBeDefined();
  if (!getJob) throw new Error("missing organize job handler");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = await getJob({ jobId }) as MemoryOrganizeJob;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("organize job did not finish");
}
