import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { DailyRoutine } from "@lume/shared";
import { readRoutine, writeRoutine } from "../../../routine/routine-store";
import { triggerRoutineEntry } from "../../../routine/routine-executor";
import { triggerRoutineEntry } from "../../../routine/routine-executor";
import {
  generateDailyRoutine,
} from "../../../routine/routine-generator";
import { scheduleRoutineEntries } from "../../../routine/routine-executor";
import { createSdkJsonResultTool } from "../sdk-tool-result";

// ─── Helpers ────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Tools ──────────────────────────────────────────────────────────

export function createRoutineTools(_input: { workspaceId?: string }): ToolDefinition[] {
  return [
    // ─── routine_read ─────────────────────────────────────────────
    createSdkJsonResultTool({
      name: "routine_read",
      description: "查看指定日期的每日日程安排。默认读取今天。返回每个活动的状态、执行时间和结果。",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期 YYYY-MM-DD，默认今天" },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        const date = asString(input.date) ?? today();
        const routine = readRoutine(date);
        return { ok: true, routine };
      },
    }),

    // ─── routine_trigger ──────────────────────────────────────────
    createSdkJsonResultTool({
      name: "routine_trigger",
      description: "手动触发今日日程中的某个条目，立即执行。触发后底层会自动创建自动化任务并执行。",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "日程条目 ID（从 routine_read 返回中获取）" },
        },
        required: ["entryId"],
      },
      async call(input) {
        const entryId = asString(input.entryId);
        if (!entryId) throw new Error("entryId 必填");
        const routine = triggerRoutineEntry(entryId);
        if (!routine) {
          return { ok: false, error: `触发失败，找不到条目: ${entryId}` };
        }
        return { ok: true, entryId };
      },
    }),

    // ─── routine_update ───────────────────────────────────────────
    createSdkJsonResultTool({
      name: "routine_update",
      description: "修改今日日程中的条目。可更新 description、customPrompt、customName、scheduledAt。",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "日程条目 ID" },
          description: { type: "string", description: "更新描述" },
          customPrompt: { type: "string", description: "覆盖执行 prompt（自定义活动）" },
          customName: { type: "string", description: "覆盖显示名称" },
          scheduledAt: { type: "number", description: "调整执行时间戳（毫秒）" },
        },
        required: ["entryId"],
      },
      async call(input) {
        const entryId = asString(input.entryId);
        if (!entryId) throw new Error("entryId 必填");

        const date = today();
        const routine = readRoutine(date);
        if (!routine) throw new Error("今日无日程");

        const entry = routine.entries.find((e) => e.id === entryId);
        if (!entry) throw new Error(`条目不存在: ${entryId}`);

        if (input.description !== undefined) {
          entry.description = asString(input.description) ?? undefined;
        }
        if (input.customPrompt !== undefined) {
          entry.customPrompt = asString(input.customPrompt) ?? undefined;
        }
        if (input.customName !== undefined) {
          entry.customName = asString(input.customName) ?? undefined;
        }
        if (input.scheduledAt !== undefined) {
          entry.scheduledAt = asNumber(input.scheduledAt)!;
        }

        // Write back the updated routine
        writeRoutine(routine);
        return { ok: true, routine };
      },
    }),

    // ─── routine_regenerate ───────────────────────────────────────
    createSdkJsonResultTool({
      name: "routine_regenerate",
      description: "重新生成今日日程。force=true 时保留已完成条目；不传 force 或 force=false 时完全重新生成。",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", description: "是否保留已完成条目，默认 false" },
        },
      },
      async call(input) {
        const force = input.force === true;
        const date = today();
        const routine = await generateDailyRoutine(date, force);
        await scheduleRoutineEntries(routine);
        return { ok: true, routine };
      },
    }),
  ];
}
