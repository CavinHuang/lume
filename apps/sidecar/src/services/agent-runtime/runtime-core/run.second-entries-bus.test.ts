import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeCodingReport, SdkEventEnvelope } from "@lume/shared";
import { getThreadEventBus } from "../events/thread-event-bus";
import { getRuntimeCoreSessionDir } from "./session-store";
import { publishCodingReportToBus, publishLspDiagnosticsToBus } from "./run";

function lspDiagnosticsMessage(fields: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "lsp_diagnostics",
    tool_use_id: "tu-1",
    file_path: "src/a.ts",
    mutation_version: 3,
    sha256: "abc123",
    delayed: true,
    diagnostics: {
      servers: ["tsserver"],
      total: 2,
      errors: 1,
      warnings: 1,
      truncated: false,
      items: [{
        server: "tsserver",
        severity: 1,
        message: "oops",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      }]
    },
    ...fields
  };
}

const codingReport = {
  status: "unverified",
  workspaceChanged: true,
  pendingBackground: false,
  gitActions: [],
  runId: "lume-run-1"
} as unknown as RuntimeCodingReport;

function isLspDiagnosticsDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "lsp.diagnostics";
}

function isCodingReportDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "coding.report";
}

describe("批次5 第二入口:lsp.diagnostics(handleAsyncEvent 旁路 helper)", () => {
  const dirs: string[] = [];
  const previousFlag = process.env.AGENT_LIFECYCLE_EVENTS;
  const hadFlag = previousFlag !== undefined;

  afterEach(() => {
    if (hadFlag) {
      process.env.AGENT_LIFECYCLE_EVENTS = previousFlag;
    } else {
      delete process.env.AGENT_LIFECYCLE_EVENTS;
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(threadId: string): { sessionDir: string; published: SdkEventEnvelope[] } {
    const agentDir = mkdtempSync(join(tmpdir(), "run-lsp-bus-"));
    dirs.push(agentDir);
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isLspDiagnosticsDetail(envelope.detail)) published.push(envelope);
    });
    return { sessionDir, published };
  }

  test("flag on: 字段与旧路 lsp.diagnostics.updated 逐一对齐", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const threadId = "run-lsp-bus-on";
    const { sessionDir, published } = setup(threadId);

    publishLspDiagnosticsToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lspDiagnosticsMessage() as never
    });

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe("lume-run-1");
    expect(envelope.detail).toEqual({
      type: "lsp.diagnostics",
      toolUseId: "tu-1",
      filePath: "src/a.ts",
      mutationVersion: 3,
      sha256: "abc123",
      delayed: true,
      diagnostics: lspDiagnosticsMessage().diagnostics
    });

    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "lsp.diagnostics", filePath: "src/a.ts" })
      }));
  });

  test("flag off: 零行为,总线无 publish", async () => {
    delete process.env.AGENT_LIFECYCLE_EVENTS;
    const threadId = "run-lsp-bus-off";
    const { sessionDir, published } = setup(threadId);

    publishLspDiagnosticsToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lspDiagnosticsMessage() as never
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });

  test("filePath/sha256 缺失丢弃(同旧路 run-item-events gate)", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const threadId = "run-lsp-bus-gate";
    const { sessionDir, published } = setup(threadId);

    publishLspDiagnosticsToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lspDiagnosticsMessage({ sha256: "" }) as never
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });
});

describe("批次5 第二入口:coding.report(publishCodingReport 产生点双发 helper)", () => {
  const dirs: string[] = [];
  const previousFlag = process.env.AGENT_LIFECYCLE_EVENTS;
  const hadFlag = previousFlag !== undefined;

  afterEach(() => {
    if (hadFlag) {
      process.env.AGENT_LIFECYCLE_EVENTS = previousFlag;
    } else {
      delete process.env.AGENT_LIFECYCLE_EVENTS;
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(threadId: string): { sessionDir: string; published: SdkEventEnvelope[] } {
    const agentDir = mkdtempSync(join(tmpdir(), "run-coding-bus-"));
    dirs.push(agentDir);
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isCodingReportDetail(envelope.detail)) published.push(envelope);
    });
    return { sessionDir, published };
  }

  test("flag on: publish coding.report,detail.report 与旧路 codingReport 同引用", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const threadId = "run-coding-bus-on";
    const { sessionDir, published } = setup(threadId);

    publishCodingReportToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      report: codingReport
    });

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe("lume-run-1");
    // detail.report 为同一引用(双发共享,非复制)
    expect((envelope.detail as { report: unknown }).report).toBe(codingReport);

    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "coding.report" })
      }));
  });

  test("flag off: 零行为,总线无 publish", async () => {
    delete process.env.AGENT_LIFECYCLE_EVENTS;
    const threadId = "run-coding-bus-off";
    const { sessionDir, published } = setup(threadId);

    publishCodingReportToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      report: codingReport
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });
});
