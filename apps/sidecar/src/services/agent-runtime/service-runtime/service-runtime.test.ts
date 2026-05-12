import { describe, expect, test } from "bun:test";
import { ServiceRuntime } from "./service-runtime";

describe("ServiceRuntime", () => {
  test("schedule 应立即返回，不等待后台 job 完成", async () => {
    const runtime = new ServiceRuntime();
    let releaseJob: (() => void) | undefined;
    let jobCompleted = false;

    runtime.schedule({
      id: "slow-memory-flush",
      type: "memory.flush",
      run: async () => {
        await new Promise<void>((resolve) => {
          releaseJob = resolve;
        });
        jobCompleted = true;
      }
    });

    expect(jobCompleted).toBe(false);
    releaseJob?.();

    const results = await runtime.drainForTest();

    expect(jobCompleted).toBe(true);
    expect(results.at(-1)).toEqual(expect.objectContaining({
      id: "slow-memory-flush",
      type: "memory.flush",
      status: "completed"
    }));
  });

  test("失败的后台 job 应被隔离为 failed 结果，而不是向主流程抛出", async () => {
    const runtime = new ServiceRuntime();

    expect(() => {
      runtime.schedule({
        id: "failing-job",
        type: "memory.flush",
        run: async () => {
          throw new Error("flush failed");
        }
      });
    }).not.toThrow();

    const results = await runtime.drainForTest();

    expect(results.at(-1)).toEqual(expect.objectContaining({
      id: "failing-job",
      type: "memory.flush",
      status: "failed",
      error: "flush failed"
    }));
  });
});
