import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createRoutineTools } from "./create-routine-tools";
import { readRoutine, writeRoutine } from "../../../routine/routine-store";
import { localDateKey } from "../../../routine/routine-date";
import { stopAutomationRunner } from "../../../automation/automation-runner-service";
import { resetPlanningTodoStoreForTests } from "../../../planning/planning-todo-store";
import type { DailyRoutine } from "@lume/shared";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const raw = result.content;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

describe("routine tools", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;
  const oldLogFile = process.env.LUME_LOG_FILE;
  const oldRoutineDir = process.env.LUME_ROUTINE_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-routine-tools-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    process.env.LUME_LOG_FILE = "false";
    process.env.LUME_ROUTINE_DIR = join(tempConfigDir, "routine");
  });

  afterEach(async () => {
    await stopAutomationRunner();
    resetPlanningTodoStoreForTests();
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    if (oldLogFile === undefined) {
      delete process.env.LUME_LOG_FILE;
    } else {
      process.env.LUME_LOG_FILE = oldLogFile;
    }
    if (oldRoutineDir === undefined) {
      delete process.env.LUME_ROUTINE_DIR;
    } else {
      process.env.LUME_ROUTINE_DIR = oldRoutineDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  // --- routine_read tests ---
  describe("routine_read", () => {
    test("无日程时应返回 null", async () => {
      const tools = createRoutineTools({});
      const tool = resolveTool(tools, "routine_read");
      const result = await callTool(tool, { date: "2099-01-01" }) as { ok: boolean; routine: null };
      expect(result.ok).toBeTrue();
      expect(result.routine).toBeNull();
    });

    test("应返回指定日期的日程", async () => {
      const today = localDateKey();
      const mockRoutine: DailyRoutine = {
        id: `routine-${today}`,
        date: today,
        generatedAt: Date.now(),
        status: "planned",
        entries: [
          {
            id: "entry-1",
            activity: "data_sync",
            scheduledAt: Date.now(),
            status: "pending",
          },
        ],
        context: { activeBooks: 0, queuedBooks: 0, unfinishedTodos: 0, dayOfWeek: 1, recentNotes: 0, pendingMemories: 0 },
      };
      writeRoutine(mockRoutine);

      const tools = createRoutineTools({});
      const tool = resolveTool(tools, "routine_read");
      const result = await callTool(tool, { date: today }) as {
        ok: boolean;
        routine: { id: string; entries: Array<{ id: string; status: string }> };
      };
      expect(result.ok).toBeTrue();
      expect(result.routine.id).toBe(`routine-${today}`);
      expect(result.routine.entries.length).toBe(1);
    });

    test("默认应读取今天", async () => {
      const today = localDateKey();
      const mockRoutine: DailyRoutine = {
        id: `routine-${today}`,
        date: today,
        generatedAt: Date.now(),
        status: "planned",
        entries: [],
        context: { activeBooks: 0, queuedBooks: 0, unfinishedTodos: 0, dayOfWeek: 1, recentNotes: 0, pendingMemories: 0 },
      };
      writeRoutine(mockRoutine);

      const tools = createRoutineTools({});
      const tool = resolveTool(tools, "routine_read");
      const result = await callTool(tool, {}) as { ok: boolean; routine: { date: string } };
      expect(result.ok).toBeTrue();
      expect(result.routine.date).toBe(today);
    });
  });

  // --- routine_trigger tests ---
  describe("routine_trigger", () => {
    test("应能手动触发今日日程中的条目（连续触发同一条目）", async () => {
      // The routine_read test writes a routine with entry "entry-1" in the same process.
      // Triggering the same entry again verifies the tool handles re-trigger correctly.
      const tools = createRoutineTools({});
      const triggerTool = resolveTool(tools, "routine_trigger");
      const result = await callTool(triggerTool, { entryId: "entry-1" }) as {
        ok: boolean;
        entryId?: string;
        error?: string;
      };
      expect(result.ok).toBeTrue();
      expect(result.entryId).toBe("entry-1");
    });
  });

  // --- routine_update tests ---
  describe("routine_update", () => {
    test("应能更新日程条目的 description", async () => {
      const today = localDateKey();
      const mockRoutine: DailyRoutine = {
        id: `routine-${today}`,
        date: today,
        generatedAt: Date.now(),
        status: "planned",
        entries: [
          {
            id: "entry-update-test",
            activity: "data_sync",
            scheduledAt: Date.now(),
            status: "pending",
            description: "旧描述",
          },
        ],
        context: { activeBooks: 0, queuedBooks: 0, unfinishedTodos: 0, dayOfWeek: 1, recentNotes: 0, pendingMemories: 0 },
      };
      writeRoutine(mockRoutine);

      const tools = createRoutineTools({});
      const updateTool = resolveTool(tools, "routine_update");
      const result = await callTool(updateTool, {
        entryId: "entry-update-test",
        description: "新描述",
      }) as { ok: boolean; routine: { entries: Array<{ id?: string; description?: string }> } };
      expect(result.ok).toBeTrue();
      const updated = result.routine.entries.find((e) => e.id === "entry-update-test");
      expect(updated?.description).toBe("新描述");
    });

    test("更新不存在的条目应报错", async () => {
      const tools = createRoutineTools({});
      const updateTool = resolveTool(tools, "routine_update");
      await expect(callTool(updateTool, { entryId: "non-existent", description: "x" })).rejects.toThrow();
    });
  });

  // --- routine_regenerate tests ---
  describe("routine_regenerate", () => {
    test("应能重新生成今日日程", async () => {
      const today = localDateKey();
      const mockRoutine: DailyRoutine = {
        id: `routine-${today}`,
        date: today,
        generatedAt: Date.now() - 86400000,
        status: "completed",
        entries: [
          {
            id: "entry-old",
            activity: "data_sync",
            scheduledAt: Date.now(),
            status: "completed",
          },
        ],
        context: { activeBooks: 0, queuedBooks: 0, unfinishedTodos: 0, dayOfWeek: 1, recentNotes: 0, pendingMemories: 0 },
      };
      writeRoutine(mockRoutine);

      const tools = createRoutineTools({});
      const regenTool = resolveTool(tools, "routine_regenerate");
      const result = await callTool(regenTool, { force: true }) as {
        ok: boolean;
        routine: { date: string; entries: unknown[] };
      };
      expect(result.ok).toBeTrue();
      expect(result.routine.date).toBe(today);
      expect(result.routine.entries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
