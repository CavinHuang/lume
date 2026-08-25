import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearProcessJobs,
  createProcessJobRecord,
  ProcessOutputTool,
  ProcessStopTool,
} from "./process-job-registry";

const contextFor = (sessionId: string | undefined) =>
  ({ sessionId, artifactsRoot: undefined, abortSignal: undefined }) as never;

function seedJob(id: string, threadId: string): void {
  createProcessJobRecord({
    id,
    subject: `job-${id}`,
    status: "running",
    threadId,
  });
}

function messageOf(result: unknown): string {
  const r = result as { content?: string; data?: string };
  return r.content ?? r.data ?? "";
}

/** 本工具关注点：跨会话必须以 ownership 错误拒绝；同会话不得因归属被拒（后续行为由各自路径决定）。 */
describe("process job ownership (#647 P2-10)", () => {
  beforeEach(() => {
    clearProcessJobs();
  });

  test("ProcessStop 拒绝停止他线会话的 job，同会话不因归属被拒", async () => {
    seedJob("own-1", "thread-a");
    seedJob("foreign-1", "thread-b");

    const foreign = await ProcessStopTool.call({ processId: "foreign-1" }, contextFor("thread-a"));
    expect(foreign.is_error).toBe(true);
    expect(messageOf(foreign)).toContain("another session");

    // 同会话路径：无 worker 的 fixture 走 "Failed to stop"——钉死预期文案，
    // 防止归属门误伤 own 时被无关错误掩盖
    const own = await ProcessStopTool.call({ processId: "own-1" }, contextFor("thread-a"));
    expect(own.is_error).toBe(true);
    expect(messageOf(own)).toContain("Failed to stop");
    expect(messageOf(own)).not.toContain("another session");
  });

  test("ProcessOutput 拒绝读取他线会话的 job，同会话放行", async () => {
    seedJob("own-2", "thread-a");
    seedJob("foreign-2", "thread-b");

    const foreign = await ProcessOutputTool.call({ processId: "foreign-2", block: false }, contextFor("thread-a"));
    expect(foreign.is_error).toBe(true);
    expect(messageOf(foreign)).toContain("another session");

    const own = await ProcessOutputTool.call({ processId: "own-2", block: false }, contextFor("thread-a"));
    expect(own.is_error).toBeFalsy();
  });

  test("守卫位于阻塞等待之前：跨会话 block:true 立即拒绝而非挂满超时", async () => {
    seedJob("foreign-3", "thread-b");

    const startedAt = Date.now();
    const foreign = await ProcessOutputTool.call(
      { processId: "foreign-3", block: true, timeout: 600_000 },
      contextFor("thread-a"),
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(foreign.is_error).toBe(true);
    expect(messageOf(foreign)).toContain("another session");
  });

  test("fail-open 第四格：job 带 threadId 而调用方无 sessionId 时放行", async () => {
    seedJob("legacy-2", "thread-a");

    const result = await ProcessOutputTool.call({ processId: "legacy-2", block: false }, contextFor(undefined));
    expect(result.is_error).toBeFalsy();
  });

  test("无归属信息的存量 job 保持可用（fail-open）", async () => {
    createProcessJobRecord({
      id: "legacy-1",
      subject: "legacy",
      status: "completed",
      output: "done",
    });

    const result = await ProcessOutputTool.call({ processId: "legacy-1", block: false }, contextFor("thread-any"));
    expect(result.is_error).toBeFalsy();
    expect(messageOf(result)).toContain("done");
  });
});
