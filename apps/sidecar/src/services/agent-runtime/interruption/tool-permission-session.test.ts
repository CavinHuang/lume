import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { createFileBackedLumeInterruptionStore } from "./interruption-store";
import { createFileBackedRunContinuationStore } from "../runtime-core/run-continuation-store";
import { runtimePermissionSessionStore } from "../permissions/permission-session";
import {
  listPendingToolPermissionRequests,
  markToolFingerprintAllowed,
  setToolPermissionApprovalSession,
  submitToolPermissionDecision,
  waitForToolPermissionDecision
} from "./tool-permission-session";

describe("tool-permission-session", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    runtimePermissionSessionStore.clear("s2");
    runtimePermissionSessionStore.clear("s2-fingerprint");
    runtimePermissionSessionStore.clear("parent-session");
    runtimePermissionSessionStore.clear("child-session");
    runtimePermissionSessionStore.clear("cold-continuation-thread");
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("wait + submit 应返回用户决策", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "s1",
        requestId: "req-1",
        toolUseId: "tool-1",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "ls" }
      },
      new AbortController().signal,
      () => {}
    );
    const handled = submitToolPermissionDecision({
      threadId: "s1",
      requestId: "req-1",
      decision: "allow_once"
    });
    expect(handled).toBeTrue();
    const decision = await waitPromise;
    expect(decision).toBe("allow_once");
  });

  test("持久化失败时 done 仍必须 resolve（不允许无限悬挂）", async () => {
    // 配置根指向普通文件 → 其下所有目录/文件写入抛 ENOTDIR，模拟 AV 锁/磁盘满等 IO 失败
    const invalidBase = join(tmpdir(), `lume-tps-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    writeFileSync(invalidBase, "not-a-dir", "utf-8");
    process.env.LUME_CONFIG_DIR = invalidBase;
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "s-io-failure",
        requestId: "req-io-failure",
        toolUseId: "tool-io-failure",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "ls" }
      },
      new AbortController().signal,
      () => {}
    );
    const handled = submitToolPermissionDecision({
      threadId: "s-io-failure",
      requestId: "req-io-failure",
      decision: "allow_once"
    });
    expect(handled).toBeTrue();
    const decision = await Promise.race([
      waitPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("waitForToolPermissionDecision 未在持久化失败后 resolve")), 5_000);
      })
    ]);
    expect(decision).toBe("allow_once");
  });

  test("allow_always 必须按 fingerprint 写入 Permission Runtime 会话缓存", () => {
    expect(runtimePermissionSessionStore.isFingerprintGranted("s2", "bash:ls")).toBeFalse();
    markToolFingerprintAllowed("s2");
    expect(runtimePermissionSessionStore.isFingerprintGranted("s2", "bash:ls")).toBeFalse();
    markToolFingerprintAllowed("s2", "bash:ls");
    expect(runtimePermissionSessionStore.isFingerprintGranted("s2", "bash:ls")).toBeTrue();
  });

  test("allow_always fingerprint 不应泄露到同名不同输入", () => {
    markToolFingerprintAllowed("s2-fingerprint", "bash:ls");

    expect(runtimePermissionSessionStore.isFingerprintGranted("s2-fingerprint", "bash:ls")).toBeTrue();
    expect(runtimePermissionSessionStore.isFingerprintGranted("s2-fingerprint", "bash:rm -rf /tmp/nope")).toBeFalse();
  });

  test("allow_always 应遵守请求级审批策略", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "s-policy",
        requestId: "req-policy",
        toolUseId: "tool-policy",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        canAllowAlways: false,
        input: { command: "git status" }
      },
      new AbortController().signal,
      () => {}
    );
    expect(() => submitToolPermissionDecision({
      threadId: "s-policy",
      requestId: "req-policy",
      decision: "allow_always"
    })).toThrow("当前审批策略不允许始终允许");
    submitToolPermissionDecision({
      threadId: "s-policy",
      requestId: "req-policy",
      decision: "deny"
    });
    expect(await waitPromise).toBe("deny");
  });

  test("本线程全部允许应遵守请求级审批策略", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "s-thread-policy",
        requestId: "req-thread-policy",
        toolUseId: "tool-thread-policy",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        canAllowAlways: false,
        input: { command: "git status" }
      },
      new AbortController().signal,
      () => {}
    );
    expect(() => submitToolPermissionDecision({
      threadId: "s-thread-policy",
      requestId: "req-thread-policy",
      decision: "allow_once",
      threadPermissionMode: "bypassPermissions"
    })).toThrow("当前审批策略不允许切换为全部允许");
    expect(runtimePermissionSessionStore.isBypassed("s-thread-policy")).toBeFalse();
    submitToolPermissionDecision({
      threadId: "s-thread-policy",
      requestId: "req-thread-policy",
      decision: "deny"
    });
    expect(await waitPromise).toBe("deny");
  });

  test("应支持由父会话提交子会话权限决策", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "child-session",
        requestId: "req-proxy",
        toolUseId: "tool-proxy",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    );
    setToolPermissionApprovalSession("req-proxy", "parent-session");
    const handled = submitToolPermissionDecision({
      threadId: "parent-session",
      requestId: "req-proxy",
      decision: "allow_once"
    });
    expect(handled).toBeTrue();
    const decision = await waitPromise;
    expect(decision).toBe("allow_once");
  });

  test("提交本线程全部允许时应切换审批会话和原始运行会话", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "child-session",
        requestId: "req-bypass",
        toolUseId: "tool-bypass",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    );
    setToolPermissionApprovalSession("req-bypass", "parent-session");

    const handled = submitToolPermissionDecision({
      threadId: "parent-session",
      requestId: "req-bypass",
      decision: "allow_once",
      threadPermissionMode: "bypassPermissions"
    });

    expect(handled).toBeTrue();
    expect(runtimePermissionSessionStore.isBypassed("parent-session")).toBeTrue();
    expect(runtimePermissionSessionStore.isBypassed("child-session")).toBeTrue();
    expect(await waitPromise).toBe("allow_once");
  });

  test("listPending 应保留 subagentLabel，供 UI 展示子代理名称", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "child-session",
        originThreadId: "child-session",
        subagentRunId: "run-1",
        subagentLabel: "探索工具能力边界",
        requestId: "req-label",
        toolUseId: "tool-label",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    );

    setToolPermissionApprovalSession("req-label", "parent-session");
    const pending = listPendingToolPermissionRequests();
    expect(pending[0]?.threadId).toBe("parent-session");
    expect(pending[0]?.subagentLabel).toBe("探索工具能力边界");

    submitToolPermissionDecision({
      threadId: "parent-session",
      requestId: "req-label",
      decision: "deny"
    });
    await waitPromise;
  });

  test("应持久化工具审批并在提交后写入 resolution", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-persist-"));
    const threadId = "persist-thread";
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId,
        requestId: "persist-req",
        toolUseId: "persist-tool",
        toolName: "Bash",
        risk: "high",
        reason: "needs approval",
        input: { command: "git push origin main" }
      },
      new AbortController().signal,
      () => {}
    );

    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    expect((await store.listPendingByThread(threadId)).map((item) => item.id)).toEqual([
      "tool_approval:persist-req"
    ]);

    submitToolPermissionDecision({
      threadId,
      requestId: "persist-req",
      decision: "allow_always"
    });
    expect(await waitPromise).toBe("allow_always");
    const resolved = await store.get("tool_approval:persist-req");
    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolution?.rememberDecision).toBeTrue();
  });

  test("工具审批解决后应保存可执行一次的 V2 cold-start checkpoint", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-continuation-"));
    const threadId = "continuation-thread";
    const runId = "run-continuation";
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId,
        runId,
        requestId: "continuation-req",
        toolUseId: "continuation-tool",
        toolName: "Bash",
        risk: "high",
        reason: "needs approval",
        grantSuggestion: {
          fingerprint: "bash:git status",
          label: "允许相同 Bash 调用"
        },
        input: { command: "git status" }
      },
      new AbortController().signal,
      () => {}
    );

    const continuationStore = createFileBackedRunContinuationStore(getRuntimeCoreSessionDir(threadId));
    expect((await continuationStore.get(runId))?.status).toBe("waiting_for_interruption");

    submitToolPermissionDecision({
      threadId,
      requestId: "continuation-req",
      decision: "allow_once"
    });
    expect(await waitPromise).toBe("allow_once");

    const continuation = await continuationStore.get(runId);
    expect(continuation).toMatchObject({
      version: 2,
      status: "ready_to_execute",
      checkpoint: {
        step: "before_tool_execution",
        toolCallId: "continuation-tool",
        toolName: "Bash",
        toolCall: {
          id: "continuation-tool",
          name: "Bash",
          input: { command: "git status" },
          kind: "execute"
        }
      }
    });
    expect(continuation?.reason).toContain("执行原工具调用一次");
  });

  test("自动化执行的工具审批应持久化为 automation_approval", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-automation-"));
    const threadId = "automation-thread";
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId,
        requestId: "automation-req",
        toolUseId: "automation-tool",
        toolName: "Bash",
        risk: "high",
        reason: "automation needs approval",
        input: { command: "deploy" },
        interruptionType: "automation_approval",
        automationJobId: "job-1",
        automationTrigger: "schedule"
      },
      new AbortController().signal,
      () => {}
    );

    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    const [pending] = await store.listPendingByThread(threadId);
    expect(pending?.type).toBe("automation_approval");
    expect(listPendingToolPermissionRequests().find((request) => request.requestId === "automation-req")).toMatchObject({
      automationJobId: "job-1",
      automationTrigger: "schedule"
    });

    submitToolPermissionDecision({
      threadId,
      requestId: "automation-req",
      decision: "deny"
    });
    await waitPromise;
    expect((await store.get("tool_approval:automation-req"))?.status).toBe("rejected");
  });

  test("冷启动后没有 live resolver 时也应能拒绝落盘 automation_approval", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-automation-cold-"));
    const threadId = "automation-cold-thread";
    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    await store.upsert({
      id: "tool_approval:automation-cold-req",
      threadId,
      type: "automation_approval",
      status: "pending",
      title: "确认自动化执行 Bash",
      message: "needs approval",
      payload: {
        threadId,
        requestId: "automation-cold-req",
        toolUseId: "automation-cold-tool",
        toolName: "Bash",
        risk: "high",
        reason: "needs approval",
        input: { command: "deploy" },
        interruptionType: "automation_approval"
      },
      source: {
        toolName: "Bash",
        toolCallId: "automation-cold-tool"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const handled = submitToolPermissionDecision({
      threadId,
      requestId: "automation-cold-req",
      decision: "deny"
    });

    expect(handled).toBeTrue();
    expect((await store.get("tool_approval:automation-cold-req"))?.status).toBe("rejected");
  });

  test("冷启动后没有 live resolver 时也应能拒绝落盘工具审批", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-cold-"));
    const threadId = "cold-thread";
    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    await store.upsert({
      id: "tool_approval:cold-req",
      threadId,
      type: "tool_approval",
      status: "pending",
      title: "确认执行 Bash",
      message: "needs approval",
      payload: {
        threadId,
        requestId: "cold-req",
        toolUseId: "cold-tool",
        toolName: "Bash",
        risk: "high",
        reason: "needs approval",
        input: { command: "git push origin main" }
      },
      source: {
        toolName: "Bash",
        toolCallId: "cold-tool"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const handled = submitToolPermissionDecision({
      threadId,
      requestId: "cold-req",
      decision: "deny"
    });

    expect(handled).toBeTrue();
    expect((await store.get("tool_approval:cold-req"))?.status).toBe("rejected");
  });

  test("冷启动批准落盘工具审批后只记录结果，不触发重新规划恢复", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-tool-permission-cold-continuation-"));
    const threadId = "cold-continuation-thread";
    const runId = "cold-continuation-run";
    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    const continuationStore = createFileBackedRunContinuationStore(getRuntimeCoreSessionDir(threadId));
    await continuationStore.upsert({
      version: 1,
      runId,
      threadId,
      status: "waiting_for_interruption",
      checkpoint: {
        step: "before_model_call",
        interruptionId: "tool_approval:cold-continuation-req",
        toolCallId: "cold-continuation-tool",
        toolName: "Bash"
      },
      reason: "等待工具审批。",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });
    await store.upsert({
      id: "tool_approval:cold-continuation-req",
      runId,
      threadId,
      type: "tool_approval",
      status: "pending",
      title: "确认执行 Bash",
      message: "needs approval",
      payload: {
        threadId,
        runId,
        requestId: "cold-continuation-req",
        toolUseId: "cold-continuation-tool",
        toolName: "Bash",
        risk: "high",
        reason: "needs approval",
        grantSuggestion: {
          fingerprint: "bash:git status",
          label: "允许相同 Bash 调用"
        },
        input: { command: "git status" }
      },
      source: {
        toolName: "Bash",
        toolCallId: "cold-continuation-tool"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const handled = submitToolPermissionDecision({
      threadId,
      requestId: "cold-continuation-req",
      decision: "allow_always"
    });

    expect(handled).toBeTrue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimePermissionSessionStore.isFingerprintGranted(threadId, "bash:git status")).toBeTrue();
    expect(await continuationStore.get(runId)).toMatchObject({
      status: "not_resumable",
      checkpoint: {
        step: "before_model_call"
      }
    });
  });
});
