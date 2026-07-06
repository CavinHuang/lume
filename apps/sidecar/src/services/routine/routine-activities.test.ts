import { describe, expect, test } from "bun:test";
import type { RoutineContext } from "@lume/shared";
import { getActivityExecutor } from "./routine-activities";

function ctx(over: Partial<RoutineContext> = {}): RoutineContext {
  return {
    activeBooks: 0,
    queuedBooks: 0,
    unfinishedTodos: 0,
    dayOfWeek: 1,
    recentNotes: 0,
    pendingMemories: 0,
    ...over,
  };
}

describe("book_discover 活动", () => {
  const executor = getActivityExecutor("book_discover");

  test("执行器已注册", () => {
    expect(executor).toBeDefined();
    expect(executor?.activity).toBe("book_discover");
  });

  test("shouldInclude：仅当无在读且无 queued 时触发", () => {
    expect(executor?.shouldInclude(ctx({ activeBooks: 0, queuedBooks: 0 }))).toBe(true);
    expect(executor?.shouldInclude(ctx({ activeBooks: 1, queuedBooks: 0 }))).toBe(false);
    expect(executor?.shouldInclude(ctx({ activeBooks: 0, queuedBooks: 1 }))).toBe(false);
    expect(executor?.shouldInclude(ctx({ activeBooks: 2, queuedBooks: 3 }))).toBe(false);
  });

  test("buildJobInput：prompt 指示 add queued 书并晋升，schedule 为 once", () => {
    const entry = { id: "e1", activity: "book_discover" as const, scheduledAt: 1234, status: "pending" as const };
    const input = executor!.buildJobInput(entry, ctx());
    expect(input.schedule).toEqual({ type: "once", runAt: 1234 });
    expect(input.enabled).toBe(true);
    const prompt = input.prompt ?? "";
    expect(prompt).toContain("lume_reading_snapshot");
    expect(prompt).toContain("lume_add_book");
    expect(prompt.toLowerCase()).toContain("queued");
    expect(prompt).toContain("lume_reading_pick_next");
  });
});
