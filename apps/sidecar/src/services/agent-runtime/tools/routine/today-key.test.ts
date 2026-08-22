import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { DailyRoutine } from "@lume/shared";
import { ROUTINE_IPC_CHANNELS } from "@lume/shared";
import { createRoutineTools } from "./create-routine-tools";
import { writeRoutine } from "../../../routine/routine-store";
import { getRoutineSchedulePath } from "../../../infra/config-paths";
import { stopAutomationRunner } from "../../../automation/automation-runner-service";
import { resetPlanningTodoStoreForTests } from "../../../planning/planning-todo-store";

/**
 * 「今天」键域回归（#451）：UI/agent 主路径的默认日期必须取本地日历日
 * （localDateKey），与 runner/generator 同域；UTC 键会让当地晚间读空、
 * REGENERATE 写到昨日文件。
 *
 * bun test 进程固定按 UTC 跑，这里把时区切到 UTC+14 并用固定时钟钉住
 * 「当前时刻」：UTC 键（2026-06-15）与本地键（2026-06-16）确定性地错位，
 * 两种实现在任何宿主上均可区分。
 */

const TEST_TZ = "Pacific/Kiritimati"; // UTC+14，无夏令时
const FIXED_MS = Date.parse("2026-06-15T23:30:00Z"); // UTC 日历日 2026-06-15；+14 后为 2026-06-16
const LOCAL_KEY = "2026-06-16";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const raw = result.content;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

const RealDate = globalThis.Date;

/** 钉住零参 new Date() 的返回时刻；静态方法（Date.now 等）保持真实。 */
function installFixedInstant(ms: number): void {
  class FixedInstant extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ms);
      else super(...(args as []));
    }
  }
  globalThis.Date = FixedInstant as unknown as typeof Date;
}

function mockRoutineFor(date: string): DailyRoutine {
  return {
    id: `routine-${date}`,
    date,
    generatedAt: FIXED_MS,
    status: "planned",
    entries: [
      { id: "entry-today-key", activity: "data_sync", scheduledAt: FIXED_MS, status: "pending" }
    ],
    context: { activeBooks: 0, queuedBooks: 0, unfinishedTodos: 0, dayOfWeek: 1, recentNotes: 0, pendingMemories: 0 }
  };
}

describe("routine today key uses local calendar day (#451)", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;
  const oldLogFile = process.env.LUME_LOG_FILE;
  const oldRoutineDir = process.env.LUME_ROUTINE_DIR;
  const oldTz = process.env.TZ;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-routine-today-key-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    process.env.LUME_LOG_FILE = "false";
    process.env.LUME_ROUTINE_DIR = join(tempConfigDir, "routine");
    process.env.TZ = TEST_TZ;
  });

  afterEach(async () => {
    globalThis.Date = RealDate;
    // 注意：bun 的时区缓存经不起 delete 后重设，恢复必须走显式赋值
    process.env.TZ = oldTz ?? "UTC";
    await stopAutomationRunner();
    resetPlanningTodoStoreForTests();
    if (oldConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = oldConfigDir;
    if (oldLogFile === undefined) delete process.env.LUME_LOG_FILE;
    else process.env.LUME_LOG_FILE = oldLogFile;
    if (oldRoutineDir === undefined) delete process.env.LUME_ROUTINE_DIR;
    else process.env.LUME_ROUTINE_DIR = oldRoutineDir;
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("routine_read 默认读本地日历日的日程", async () => {
    expect(new RealDate(FIXED_MS).toISOString().slice(0, 10)).toBe("2026-06-15");
    writeRoutine(mockRoutineFor(LOCAL_KEY));

    installFixedInstant(FIXED_MS);
    try {
      const tool = resolveTool(createRoutineTools({}), "routine_read");
      const result = await callTool(tool, {}) as { ok: boolean; routine: { date: string } | null };
      expect(result.routine?.date).toBe(LOCAL_KEY);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("routine_update 定位本地日历日的今日日程", async () => {
    writeRoutine(mockRoutineFor(LOCAL_KEY));

    installFixedInstant(FIXED_MS);
    try {
      const tool = resolveTool(createRoutineTools({}), "routine_update");
      const result = await callTool(tool, { entryId: "entry-today-key", description: "新描述" }) as { ok: boolean; routine?: { date?: string } };
      expect(result.ok).toBeTrue();
      expect(result.routine?.date).toBe(LOCAL_KEY);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("GET_TODAY 读本地日历日的今日日程", async () => {
    const { createRoutineHandlers } = await import("../../../../rpc/routine-handlers");
    writeRoutine(mockRoutineFor(LOCAL_KEY));

    installFixedInstant(FIXED_MS);
    try {
      const handler = createRoutineHandlers()[ROUTINE_IPC_CHANNELS.GET_TODAY]!;
      const routine = await handler({}) as DailyRoutine | null;
      expect(routine?.date).toBe(LOCAL_KEY);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("REGENERATE 写入本地日历日文件而非昨日文件", async () => {
    // 昨日文件预置旧日程：若实现退回 UTC 键会写到/读到 2026-06-15
    writeRoutine(mockRoutineFor("2026-06-15"));
    installFixedInstant(FIXED_MS);
    try {
      const tool = resolveTool(createRoutineTools({}), "routine_regenerate");
      const result = await callTool(tool, {}) as { ok: boolean; routine: { date: string; entries: unknown[] } };
      expect(result.ok).toBeTrue();
      expect(result.routine.date).toBe(LOCAL_KEY);
      expect(existsSync(getRoutineSchedulePath(LOCAL_KEY))).toBeTrue();
    } finally {
      globalThis.Date = RealDate;
    }
  }, 20000);
});
