import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeCodingReport, SdkEventEnvelope } from "@lume/shared";
import { getThreadEventBus } from "../events/thread-event-bus";
import { getRuntimeCoreSessionDir } from "./session-store";
import { publishCodingReportToBus } from "./run-background";

const codingReport = {
  status: "unverified",
  workspaceChanged: true,
  pendingBackground: false,
  gitActions: [],
  runId: "lume-run-1"
} as unknown as RuntimeCodingReport;

function isCodingReportDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "coding.report";
}

describe("批次5 第二入口:coding.report(publishCodingReport 产生点双发 helper)", () => {
  const dirs: string[] = [];

  afterEach(() => {
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

  test("publish coding.report,detail.report 与旧路 codingReport 同引用", async () => {
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
});
