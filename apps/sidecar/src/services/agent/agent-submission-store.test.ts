import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSubmissionStore, hashAgentSubmission } from "./agent-submission-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  }
});

function createStore(now = 100) {
  const root = mkdtempSync(join(tmpdir(), "lume-submission-store-"));
  roots.push(root);
  return {
    root,
    store: new AgentSubmissionStore({ dbPath: join(root, "submissions.sqlite"), now: () => now }),
  };
}

describe("AgentSubmissionStore", () => {
  test("同一 ID + payload 返回既有 receipt，不同 payload 拒绝", () => {
    const { store } = createStore();
    const input = { threadId: "thread-a", userMessage: "hello", clientSubmissionId: "submission-a" };
    const first = store.begin(input);
    const second = store.begin({ ...input });

    expect(first?.existing).toBe(false);
    expect(second?.existing).toBe(true);
    expect(second?.receipt.payloadHash).toBe(hashAgentSubmission(input));
    expect(() => store.begin({ ...input, userMessage: "different" })).toThrow();
    store.close();
  });

  test("重启后 queued 标为 restart_dropped，started 标为 interrupted", () => {
    const { root, store } = createStore(100);
    store.begin({ threadId: "thread-a", userMessage: "queued", clientSubmissionId: "queued-a" });
    store.accept("queued-a", { ok: true, mode: "queued", queuedCount: 1 });
    store.begin({ threadId: "thread-a", userMessage: "started", clientSubmissionId: "started-a" });
    store.accept("started-a", { ok: true, mode: "sent", queuedCount: 0 });
    store.transition("started-a", "started");
    store.close();

    const reopened = new AgentSubmissionStore({ dbPath: join(root, "submissions.sqlite"), now: () => 200 });
    expect(reopened.get("queued-a")?.status).toBe("restart_dropped");
    expect(reopened.get("started-a")?.status).toBe("interrupted");
    reopened.close();
  });

  test("附件 lease 在 sent 时提交，在未 claim 的 queued 重启后清理", () => {
    const { root, store } = createStore(100);
    const sentPath = join(root, "sent.txt");
    const queuedPath = join(root, "queued.txt");
    writeFileSync(sentPath, "sent");
    writeFileSync(queuedPath, "queued");
    store.prepareAttachmentLease("sent-a", "thread-a", [{ filename: "sent.txt", targetPath: sentPath }]);
    store.prepareAttachmentLease("queued-a", "thread-a", [{ filename: "queued.txt", targetPath: queuedPath }]);
    store.begin({ threadId: "thread-a", userMessage: "sent", clientSubmissionId: "sent-a" });
    store.begin({ threadId: "thread-a", userMessage: "queued", clientSubmissionId: "queued-a" });
    store.accept("sent-a", { ok: true, mode: "sent", queuedCount: 0 });
    store.accept("queued-a", { ok: true, mode: "queued", queuedCount: 1 });
    store.close();

    const reopened = new AgentSubmissionStore({ dbPath: join(root, "submissions.sqlite"), now: () => 200 });
    expect(existsSync(sentPath)).toBe(true);
    expect(existsSync(queuedPath)).toBe(false);
    expect(reopened.get("queued-a")?.status).toBe("restart_dropped");
    reopened.close();
  });
});
