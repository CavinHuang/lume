import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkEventEnvelope } from "@lume/shared";
import { getThreadEventBus } from "../events/thread-event-bus";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { createObservedRuntimeEmitter } from "./run-loop";
import { publishAdvisorReviewedToBus } from "./lume-runner";
import type { LumeRunObserver } from "./run-observer";
import type { AgentRuntimeEmitter } from "./types";

function baseEmitter(overrides: Partial<AgentRuntimeEmitter> = {}): AgentRuntimeEmitter {
  return {
    onSdkMessage: () => {},
    onComplete: () => {},
    onError: () => {},
    onAskUserQuestion: () => {},
    onBrowserAuthRequest: () => {},
    onToolPermissionRequest: () => {},
    ...overrides
  };
}

const todoState = {
  todos: [{ content: "a", activeForm: "doing a", status: "in_progress" as const }],
  currentActiveForm: "doing a"
};

const advisorReview = {
  severity: "suggestion" as const,
  summary: "Looks acceptable",
  details: "minor nits",
  modelRef: "gpt-5",
  durationMs: 120
};

function isTodoStateDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "todo.state";
}

function isAdvisorReviewedDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "advisor.reviewed";
}

describe("批次5 第二入口:todo.state(run-loop 观察发射器)", () => {
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
    const agentDir = mkdtempSync(join(tmpdir(), "run-todo-bus-"));
    dirs.push(agentDir);
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isTodoStateDetail(envelope.detail)) published.push(envelope);
    });
    return { sessionDir, published };
  }

  test("flag on: onTodoUpdated → todo.state 总线事件,detail.state 与旧路载荷同引用", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const threadId = "run-todo-bus-on";
    const { sessionDir, published } = setup(threadId);

    const recorded: unknown[] = [];
    const observer = {
      recordTodoState: (state: unknown) => recorded.push(state),
      getThreadId: () => threadId,
      getRunId: () => "lume-run-1"
    } as unknown as LumeRunObserver;
    const legacyEmitted: unknown[] = [];
    const emitter = createObservedRuntimeEmitter(
      baseEmitter({ onTodoUpdated: (state) => legacyEmitted.push(state) }),
      observer,
      { sessionDir }
    );

    emitter.onTodoUpdated?.(todoState);

    // 旧路照走:observer 记录与旧路回调都在
    expect(recorded).toEqual([todoState]);
    expect(legacyEmitted).toEqual([todoState]);

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe("lume-run-1");
    // detail.state 为同一引用(双发共享,非复制)
    expect((envelope.detail as { type: string; state: unknown }).state).toBe(todoState);

    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "todo.state" })
      }));
  });

  test("flag off: 零行为,总线无 publish", async () => {
    delete process.env.AGENT_LIFECYCLE_EVENTS;
    const threadId = "run-todo-bus-off";
    const { sessionDir, published } = setup(threadId);

    const observer = {
      recordTodoState: () => {},
      getThreadId: () => threadId,
      getRunId: () => "lume-run-1"
    } as unknown as LumeRunObserver;
    const emitter = createObservedRuntimeEmitter(baseEmitter(), observer, { sessionDir });

    emitter.onTodoUpdated?.(todoState);

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });
});

describe("批次5 第二入口:advisor.reviewed(lume-runner 注入 helper)", () => {
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
    const agentDir = mkdtempSync(join(tmpdir(), "run-advisor-bus-"));
    dirs.push(agentDir);
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isAdvisorReviewedDetail(envelope.detail)) published.push(envelope);
    });
    return { sessionDir, published };
  }

  test("flag on: publish advisor.reviewed,detail.review 为旧路 payload 同引用", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const threadId = "run-advisor-bus-on";
    const { sessionDir, published } = setup(threadId);

    publishAdvisorReviewedToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      review: advisorReview
    });

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe("lume-run-1");
    expect(envelope.detail).toEqual({
      type: "advisor.reviewed",
      summary: "Looks acceptable",
      review: advisorReview
    });
    expect((envelope.detail as { review: unknown }).review).toBe(advisorReview);

    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "advisor.reviewed" })
      }));
  });

  test("flag off: 零行为,总线无 publish", async () => {
    delete process.env.AGENT_LIFECYCLE_EVENTS;
    const threadId = "run-advisor-bus-off";
    const { sessionDir, published } = setup(threadId);

    publishAdvisorReviewedToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      review: advisorReview
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });
});
