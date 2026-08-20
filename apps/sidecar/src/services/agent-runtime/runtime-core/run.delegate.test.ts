import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveAgentThread,
  createAgentThread,
  createAgentThreadWithModelRef,
  getAgentThreadMeta,
  listAgentThreads,
  subscribeThreadListChanged
} from "../../agent/agent-thread-manager";
import {
  getSubagentRunRegistry,
  resetSubagentRunRegistryForTest
} from "../../agent/subagents/subagent-run-registry";
import { buildBackgroundTaskResultsContext, buildSidecarSubagentRunContext, buildWaitForDelegationsResult, canDelegateFromThread, deriveDelegateTitle } from "./run";

describe("DelegateTool child thread", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("createAgentThread 携带 parentThreadId，子会话进入 listAgentThreads", () => {
    const parent = createAgentThread("父会话", undefined, "ws-1");
    const child = createAgentThread("子会话", undefined, "ws-1", parent.id);
    expect(child.parentThreadId).toBe(parent.id);
    const listed = listAgentThreads();
    expect(listed.find((t) => t.id === child.id)).toBeDefined();
    expect(listed.find((t) => t.id === child.id)?.parentThreadId).toBe(parent.id);
  });

  test("buildSidecarSubagentRunContext 通过 createChildThreadId 注入 thread id（非随机 uuid）", () => {
    const result = buildSidecarSubagentRunContext({
      parentThreadId: "parent-thread",
      toolInput: { prompt: "子任务", subagent_type: "explorer" },
      policy: { depth: 1, rootThreadId: "parent-thread" },
      createChildThreadId: () => "fixed-thread-id"
    });
    expect(result.childThreadId).toBe("fixed-thread-id");
    expect(result.registryInput.childThreadId).toBe("fixed-thread-id");
  });
});

describe("DelegateTool depth guard (D7)", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-depth-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("顶层 thread 允许 delegate", () => {
    const parent = createAgentThread("父", undefined, "ws-1");
    expect(canDelegateFromThread(parent.id).ok).toBe(true);
  });

  test("已是子会话的 thread 禁止再 delegate", () => {
    const root = createAgentThread("root", undefined, "ws-1");
    const child = createAgentThread("child", undefined, "ws-1", root.id);
    // 模拟 child 是一个 subagent run 的 childThreadId
    getSubagentRunRegistry().create({
      runId: "run-1", parentThreadId: root.id, rootThreadId: root.id,
      depth: 1, childThreadId: child.id, task: "t", cleanup: "keep", status: "running"
    });
    expect(canDelegateFromThread(child.id).ok).toBe(false);
  });

  test("父 thread 有 parentThreadId 元数据（无 registry 记录）也禁止 delegate", () => {
    const root = createAgentThread("root", undefined, "ws-1");
    const child = createAgentThread("child", undefined, "ws-1", root.id); // child.parentThreadId = root.id
    // 注意：不创建 registry 记录，仅靠 meta.parentThreadId 拦截
    expect(canDelegateFromThread(child.id).ok).toBe(false);
  });
});

describe("DelegateTool title fallback", () => {
  test("输出非空时用输出摘要作为标题（取前 20 字）", () => {
    // 输入超过 20 字，验证截断为前 20 字
    expect(deriveDelegateTitle(undefined, "这是一段超过二十个字符的子会话输出结果内容示例")).toBe("这是一段超过二十个字符的子会话输出结果内");
  });

  test("输出短于 20 字时原样作为标题", () => {
    expect(deriveDelegateTitle(undefined, "短输出")).toBe("短输出");
  });

  test("输出为空时保留原标题", () => {
    expect(deriveDelegateTitle("原标题", undefined)).toBe("原标题");
  });

  test("输出仅含空白时保留原标题", () => {
    expect(deriveDelegateTitle("原标题", "   \n\t  ")).toBe("原标题");
  });

  test("折叠输出中的多余空白后再截断", () => {
    expect(deriveDelegateTitle("原标题", "hello    world\nnext")).toBe("hello world next".slice(0, 20));
  });

  test("按码点截断，不切断 emoji 代理对", () => {
    // 21 个码点（含 emoji），截断后应为前 20 个码点，且最后一个 emoji 完整
    const input = "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓";
    const result = deriveDelegateTitle(undefined, input);
    expect(Array.from(result!).length).toBe(20);
    // 截断结果应等于按码点取前 20
    expect(result).toBe(Array.from(input).slice(0, 20).join(""));
    // 对照：旧的 UTF-16 code unit slice 会切到代理对中间，
    // slice(0,20) 得到的字符串转码点后 ≠ 20（出现孤立代理项，码点数为 11）
    expect(Array.from(input.slice(0, 20)).length).not.toBe(20);
  });
});

// ─── S2: background 委派的 completion 信号量生命周期 ───
// delegateTool.call 深度耦合 runtime 闭包（input/context/各 service），完整 mock 代价过高。
// 此处验证 background 分支依赖的外部契约：registry 的 createDelegationCompletion →
// waitForDelegations(阻塞) → resolveDelegationCompletion(唤醒) 配对，覆盖正常完成与出错两条路径。
describe("DelegateTool background delegation completion lifecycle", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-bg-"));
    resetSubagentRunRegistryForTest();
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    resetSubagentRunRegistryForTest();
  });

  test("background 委派：createCompletion + 子会话完成 resolve → waitForDelegations(all) 收敛", async () => {
    const reg = getSubagentRunRegistry();
    const parentThreadId = "parent-bg-1";
    reg.create({
      runId: "delegation-bg-1", parentThreadId, rootThreadId: parentThreadId,
      depth: 1, childThreadId: "child-bg-1", task: "bg task", cleanup: "keep", status: "running"
    });
    // 模拟 delegate background 分支启动时注册信号量
    reg.createDelegationCompletion("delegation-bg-1");

    // 父会话发起等待（应阻塞，因为子会话 running）
    const waitPromise = reg.waitForDelegations({ parentThreadId, mode: "all", timeoutMs: 2000 });

    // 模拟子会话正常结束：update 终态 + resolve（对应 then 分支的 onSubagentEnd + resolveDelegationCompletion）
    reg.update("delegation-bg-1", { status: "completed", outcome: { output: "done" } });
    reg.resolveDelegationCompletion("delegation-bg-1");

    const result = await waitPromise;
    expect(result.status).toBe("completed");
    expect(result.completedCount).toBe(1);
    expect(result.runningCount).toBe(0);
  });

  test("background 委派：子会话出错时 resolve 也能唤醒等待方（避免永久挂起）", async () => {
    const reg = getSubagentRunRegistry();
    const parentThreadId = "parent-bg-2";
    reg.create({
      runId: "delegation-bg-2", parentThreadId, rootThreadId: parentThreadId,
      depth: 1, childThreadId: "child-bg-2", task: "bg task", cleanup: "keep", status: "running"
    });
    reg.createDelegationCompletion("delegation-bg-2");

    const waitPromise = reg.waitForDelegations({ parentThreadId, mode: "all", timeoutMs: 2000 });

    // 模拟 catch 分支：update errored + resolve（即使出错也 resolve，不阻塞等待方）
    reg.update("delegation-bg-2", { status: "errored", outcome: { error: "boom" } });
    reg.resolveDelegationCompletion("delegation-bg-2");

    const result = await waitPromise;
    expect(result.status).toBe("completed");
    expect(result.completedCount).toBe(1);
    expect(result.runningCount).toBe(0);
  });

  test("background 委派：未注册 completion 的 running 子会话靠超时返回（兼容旧路径）", async () => {
    const reg = getSubagentRunRegistry();
    const parentThreadId = "parent-bg-3";
    // 只创建 run，不调用 createDelegationCompletion（模拟未接入的旧子会话）
    reg.create({
      runId: "delegation-bg-3", parentThreadId, rootThreadId: parentThreadId,
      depth: 1, childThreadId: "child-bg-3", task: "bg task", cleanup: "keep", status: "running"
    });
    const result = await reg.waitForDelegations({ parentThreadId, mode: "all", timeoutMs: 80 });
    expect(result.status).toBe("timeout");
    expect(result.runningCount).toBe(1);
  });
});

// ─── S3: WaitForDelegations 工具返回结构 ───
// 工具闭包在 createRuntimeCoreSession 内部不可直接调用，故测其纯逻辑 buildWaitForDelegationsResult。
// 用 stub registry（即时 resolve，无 timer 等待）避免测试卡顿。
describe("WaitForDelegations tool result structure", () => {
  const makeStubRegistry = (
    waitResult: { status: "completed" | "timeout"; completedCount: number; runningCount: number },
    runs: Array<{ runId: string; childThreadId: string; label?: string; status: string; outcome?: { output?: string; error?: string } }>
  ) => ({
    waitForDelegations: async () => waitResult,
    listByParentSession: () => runs
  });

  test("mode=all 全部完成：返回 completed + delegations 含 outputSummary", async () => {
    const stub = makeStubRegistry(
      { status: "completed", completedCount: 2, runningCount: 0 },
      [
        { runId: "d1", childThreadId: "c1", label: "task-A", status: "completed", outcome: { output: "result-A" } },
        { runId: "d2", childThreadId: "c2", label: "task-B", status: "completed", outcome: { output: "result-B" } }
      ]
    );
    const res = await buildWaitForDelegationsResult({ mode: "all" }, "parent-x", stub);
    expect(res.type).toBe("tool_result");
    const body = JSON.parse(res.content);
    expect(body.status).toBe("completed");
    expect(body.mode).toBe("all");
    expect(body.completedCount).toBe(2);
    expect(body.runningCount).toBe(0);
    expect(body.delegations).toHaveLength(2);
    expect(body.delegations[0]).toMatchObject({ delegationId: "d1", childThreadId: "c1", label: "task-A", status: "completed", outputSummary: "result-A" });
  });

  test("mode=any 透传 min_completed，首个完成即返回", async () => {
    const stub = makeStubRegistry(
      { status: "completed", completedCount: 1, runningCount: 1 },
      [
        { runId: "d1", childThreadId: "c1", status: "completed", outcome: { output: "ok" } },
        { runId: "d2", childThreadId: "c2", status: "running" }
      ]
    );
    const res = await buildWaitForDelegationsResult({ mode: "any", min_completed: 1, timeout_seconds: 60 }, "parent-x", stub);
    const body = JSON.parse(res.content);
    expect(body.mode).toBe("any");
    expect(body.status).toBe("completed");
    expect(body.completedCount).toBe(1);
    expect(body.runningCount).toBe(1);
  });

  test("超时：返回 timeout 且 runningCount>0", async () => {
    const stub = makeStubRegistry(
      { status: "timeout", completedCount: 0, runningCount: 1 },
      [{ runId: "d1", childThreadId: "c1", status: "running" }]
    );
    const res = await buildWaitForDelegationsResult({ mode: "all", timeout_seconds: 1 }, "parent-x", stub);
    const body = JSON.parse(res.content);
    expect(body.status).toBe("timeout");
    expect(body.runningCount).toBe(1);
    expect(body.delegations[0].delegationId).toBe("d1");
    expect(body.delegations[0].outputSummary).toBeUndefined();
  });

  test("errored 子会话 error 字段透出，无 outputSummary", async () => {
    const stub = makeStubRegistry(
      { status: "completed", completedCount: 1, runningCount: 0 },
      [{ runId: "d1", childThreadId: "c1", status: "errored", outcome: { error: "boom" } }]
    );
    const res = await buildWaitForDelegationsResult({ mode: "all" }, "parent-x", stub);
    const body = JSON.parse(res.content);
    expect(body.delegations[0]).toMatchObject({ delegationId: "d1", status: "errored", error: "boom" });
    expect(body.delegations[0].outputSummary).toBeUndefined();
  });

  test("outputSummary 截断到 2000 字", async () => {
    const longOutput = "a".repeat(3000);
    const stub = makeStubRegistry(
      { status: "completed", completedCount: 1, runningCount: 0 },
      [{ runId: "d1", childThreadId: "c1", status: "completed", outcome: { output: longOutput } }]
    );
    const res = await buildWaitForDelegationsResult({ mode: "all" }, "parent-x", stub);
    const body = JSON.parse(res.content);
    expect(body.delegations[0].outputSummary.length).toBe(2000);
  });
});

describe("background task continuation context", () => {
  test("merges success, failure, and stopped results into one structured context", () => {
    const context = buildBackgroundTaskResultsContext([
      { id: "success", kind: "subagent", status: "completed", childThreadId: "child-1", output: "done" },
      { id: "failure", kind: "subagent", status: "errored", error: "boom" },
      { id: "stopped", kind: "process", status: "stopped", output: "cancelled" }
    ]);

    expect(context.match(/<background-task-results>/g)).toHaveLength(1);
    expect(context).toContain('"id": "success"');
    expect(context).toContain('"status": "errored"');
    expect(context).toContain('"status": "stopped"');
    expect(context).toContain("untrusted task data");
  });
});

// ─── Task 工具子会话（侧栏可见）───
// sidecarAgentTool.call 闭包耦合 runtime（同 delegateTool，见上 S2 注释），完整 mock 代价过高。
// 此处验证改造所依赖的契约组合：createAgentThreadWithModelRef + buildSidecarSubagentRunContext({createChildThreadId})
// 能产出侧栏可见（listAgentThreads 可见、parentThreadId 正确、childThreadId === childMeta.id）的子会话。
describe("TaskTool child thread (sidebar-visible)", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-task-thread-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("Task 创建的子会话带 parentThreadId 且进入 listAgentThreads（侧栏可见）", () => {
    const parent = createAgentThread("母会话", undefined, "ws-1");
    // 复刻 sidecarAgentTool 改造后的行为：创建持久 childMeta 并注入 createChildThreadId
    const childMeta = createAgentThreadWithModelRef(
      "探索代码库", undefined, undefined, "ws-1", parent.id
    );
    const run = buildSidecarSubagentRunContext({
      parentThreadId: parent.id,
      parentToolUseId: "tool-use-1",
      toolInput: { prompt: "探索代码库并报告依赖", description: "探索代码库", subagent_type: "Explore" },
      policy: { depth: 1, rootThreadId: parent.id },
      createChildThreadId: () => childMeta.id
    });
    // 契约1：childThreadId 来自 childMeta（非随机 uuid）→ 消息流能正确持久化到该 thread
    expect(run.childThreadId).toBe(childMeta.id);
    expect(run.registryInput.childThreadId).toBe(childMeta.id);
    // 契约2：child 进入 listAgentThreads 且 parentThreadId 正确 → 前端 buildThreadTree 可构子会话树
    const listed = listAgentThreads();
    const listedChild = listed.find((t) => t.id === childMeta.id);
    expect(listedChild).toBeDefined();
    expect(listedChild?.parentThreadId).toBe(parent.id);
  });

  test("Task 子会话随父归档级联清理（D8，侧栏不残留）", () => {
    const parent = createAgentThread("母会话", undefined, "ws-1");
    const child = createAgentThreadWithModelRef("子任务", undefined, undefined, "ws-1", parent.id);
    archiveAgentThread(parent.id);
    expect(getAgentThreadMeta(child.id)?.status).toBe("archived");
  });
});

// ─── Thread list changed 通知（前端同步刷新的触发源）───
// sidecar 层订阅此 pub/sub 后转 writeNotification(THREAD_LIST_CHANGED) 推送前端，
// 前端在 useGlobalAgentListeners 里据此 setThreads(listThreads)，使子会话"创建即同步显示"。
describe("ThreadListChanged notification", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-thread-list-changed-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("createAgentThreadWithModelRef 触发 THREAD_LIST_CHANGED 通知", () => {
    let notifyCount = 0;
    const unsub = subscribeThreadListChanged(() => { notifyCount += 1; });
    try {
      const parent = createAgentThread("母", undefined, "ws-1");
      const child = createAgentThreadWithModelRef("子", undefined, undefined, "ws-1", parent.id);
      expect(child.parentThreadId).toBe(parent.id);
      // parent 与 child 各创建一次 → 广播 2 次
      expect(notifyCount).toBe(2);
    } finally {
      unsub();
    }
  });

  test("unsubscribe 后不再收到通知", () => {
    let notifyCount = 0;
    const unsub = subscribeThreadListChanged(() => { notifyCount += 1; });
    unsub();
    createAgentThread("x", undefined, "ws-1");
    expect(notifyCount).toBe(0);
  });

  test("单个 listener 抛错不影响其他 listener 与主流程", () => {
    let secondCalled = false;
    const unsub1 = subscribeThreadListChanged(() => { throw new Error("boom"); });
    const unsub2 = subscribeThreadListChanged(() => { secondCalled = true; });
    try {
      expect(() => createAgentThread("x", undefined, "ws-1")).not.toThrow();
      expect(secondCalled).toBe(true);
    } finally {
      unsub1();
      unsub2();
    }
  });
});
