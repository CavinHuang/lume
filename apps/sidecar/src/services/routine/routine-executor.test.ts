import { describe, expect, test } from "bun:test"
import { resolveRoutineEntryCompletion } from "./routine-executor"

describe("resolveRoutineEntryCompletion", () => {
  const doneJob = { enabled: false, lastRunAt: 1 }

  test("job 未跑完（仍 enabled 或无 lastRunAt）时不判定", () => {
    expect(
      resolveRoutineEntryCompletion({ job: { enabled: true, lastRunAt: 1 }, latestRun: { status: "failed" } })
    ).toBeNull()
    expect(
      resolveRoutineEntryCompletion({ job: { enabled: false }, latestRun: { status: "failed" } })
    ).toBeNull()
  })

  test("run 被跳过（skipped）→ 未真正执行，不判定为完成", () => {
    // skipped 表示「任务仍在运行，已跳过本次触发」——并非真正执行过，不应误标 completed。
    // 线上曾出现条目 result 为该 skip 文案、状态却显示 completed。
    expect(
      resolveRoutineEntryCompletion({
        job: doneJob,
        latestRun: { status: "skipped", message: "任务仍在运行，已跳过本次触发" },
      })
    ).toBeNull()
  })

  test("run 失败 → entry 标记 failed，summary 取 run 消息", () => {
    expect(
      resolveRoutineEntryCompletion({
        job: doneJob,
        latestRun: { status: "failed", message: "OpenAI API error: 404 Not Found" },
      })
    ).toEqual({
      status: "failed",
      result: { summary: "OpenAI API error: 404 Not Found" },
    })
  })

  test("run 失败但无消息 → summary 回退默认文案", () => {
    expect(
      resolveRoutineEntryCompletion({ job: doneJob, latestRun: { status: "failed" } })
    ).toEqual({
      status: "failed",
      result: { summary: "任务执行失败" },
    })
  })

  test("run 成功且有 LLM 回复 → completed，summary 优先用 LLM 回复", () => {
    expect(
      resolveRoutineEntryCompletion({
        job: doneJob,
        latestRun: { status: "success", message: "日志消息" },
        llmReply: "今日精选 3 条兴趣资讯",
      })
    ).toEqual({
      status: "completed",
      result: { summary: "今日精选 3 条兴趣资讯" },
    })
  })

  test("run 成功但无 LLM 回复 → summary 回退 run 消息", () => {
    expect(
      resolveRoutineEntryCompletion({
        job: doneJob,
        latestRun: { status: "success", message: "任务执行完成" },
      })
    ).toEqual({
      status: "completed",
      result: { summary: "任务执行完成" },
    })
  })

  test("job 跑完但无 run 记录 → completed 且不设 result", () => {
    expect(resolveRoutineEntryCompletion({ job: doneJob })).toEqual({ status: "completed" })
  })
})
