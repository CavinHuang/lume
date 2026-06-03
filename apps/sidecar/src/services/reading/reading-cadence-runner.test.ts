import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReadingSettings, READING_IPC_CHANNELS } from "@lume/shared";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { addReadingBook, listReadingBooks, listReadingNotes, updateReadingSettings } from "./reading-store";
import {
  buildReadingCadenceDecision,
  listReadingRunRecords,
  runReadingCadenceTick
} from "./reading-cadence-runner";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 2, 9, 0, 0);

describe("reading-cadence-runner", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-cadence-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("marks weekly cadence due and chooses a deep note when no weekly deep note exists", () => {
    expect(buildReadingCadenceDecision({
      settings: normalizeReadingSettings({ cadence: "weekly" }),
      notes: [],
      runs: [],
      now: NOW
    })).toEqual({
      due: true,
      depth: "deep",
      reason: "weekly_due"
    });
  });

  test("keeps cadence quiet until the interval has passed, then falls back to seed after a weekly deep note", () => {
    const settings = normalizeReadingSettings({ cadence: "few_times_weekly", maxDeepNotesPerWeek: 1 });
    expect(buildReadingCadenceDecision({
      settings,
      notes: [],
      runs: [{ trigger: "scheduled", status: "completed", completedAt: NOW - DAY }],
      now: NOW
    })).toEqual({
      due: false,
      reason: "cadence_wait"
    });

    expect(buildReadingCadenceDecision({
      settings,
      notes: [{ depth: "deep", createdAt: NOW - (3 * DAY), hidden: false, deleted: false }],
      runs: [{ trigger: "scheduled", status: "completed", completedAt: NOW - (3 * DAY) }],
      now: NOW
    })).toEqual({
      due: true,
      depth: "seed",
      reason: "few_times_weekly_due"
    });
  });

  test("records scheduled starter reading and does not repeat before cadence is due again", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    updateReadingSettings({ cadence: "weekly" });

    const first = await runReadingCadenceTick({
      now: NOW,
      writeNotification: (method, params) => notifications.push({ method, params })
    });
    expect(first).toMatchObject({
      status: "completed",
      message: "已写下深度读书笔记"
    });
    expect(listReadingBooks()[0]).toMatchObject({
      id: first.bookId,
      title: "人间词话"
    });
    expect(notifications).toContainEqual({
      method: READING_IPC_CHANNELS.NOTE_GEN_DONE,
      params: expect.objectContaining({
        status: "completed",
        bookTitle: "人间词话",
        trigger: "scheduled"
      })
    });

    notifications.length = 0;
    const second = await runReadingCadenceTick({
      now: NOW + (60 * 60 * 1000),
      writeNotification: (method, params) => notifications.push({ method, params })
    });
    expect(second).toMatchObject({
      status: "skipped",
      message: "读书节奏未到"
    });
    expect(notifications).toEqual([]);
    expect(listReadingRunRecords()).toHaveLength(1);
  });

  test("generates a scheduled local note when cadence is due", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    updateReadingSettings({ cadence: "weekly" });
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      progressPercent: 54
    });

    const result = await runReadingCadenceTick({
      now: NOW,
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    expect(result).toMatchObject({
      status: "completed",
      bookId: book.id
    });
    expect(notifications).toContainEqual({
      method: READING_IPC_CHANNELS.NOTE_GEN_DONE,
      params: expect.objectContaining({
        status: "completed",
        bookTitle: "我在北京送快递",
        trigger: "scheduled"
      })
    });
    expect(listReadingRunRecords()).toHaveLength(1);
  });

  test("uses the latest agent workspace for scheduled collaborative context", async () => {
    const workspace = createAgentWorkspace("读书工作区", { slug: "reading-workspace" });
    updateReadingSettings({ cadence: "weekly" });
    addReadingBook({
      title: "置身事内",
      author: "兰小欢",
      source: {
        kind: "manual",
        excerpt: "地方政府的行为，必须放在制度激励和财政约束里理解。"
      },
      progressPercent: 32
    });
    const memoryCalls: unknown[] = [];

    const result = await runReadingCadenceTick({
      now: NOW,
      contextTools: {
        searchMemory: async (input) => {
          memoryCalls.push(input);
          return [{
            id: "mem-1",
            path: "/memory/user.md",
            snippet: "用户最近在这个工作区里讨论过制度约束和日常生活。",
            score: 0.9,
            source: "memory"
          }];
        },
        listThreads: () => [],
        getRecentMessages: () => ({ messages: [], total: 0, hasMore: false })
      }
    });

    expect(result.status).toBe("completed");
    expect(memoryCalls).toEqual([expect.objectContaining({
      workspaceSlug: workspace.slug,
      includeWorkspace: true,
      includeGlobal: true
    })]);
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      userContext: expect.stringContaining("制度约束和日常生活")
    });
    expect(listReadingRunRecords()[0]).toMatchObject({
      trigger: "scheduled",
      workspaceSlug: workspace.slug
    });
  });
});
