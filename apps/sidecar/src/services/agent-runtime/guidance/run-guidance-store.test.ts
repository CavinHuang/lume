import { describe, expect, test } from "bun:test";
import { RunGuidanceStore } from "./run-guidance-store";

interface TestDispatch {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  input: {
    threadId: string;
    userMessage: string;
  };
}

function createDispatch(id: string, text: string): TestDispatch {
  return {
    id,
    threadId: "thread-a",
    text,
    createdAt: 100,
    input: {
      threadId: "thread-a",
      userMessage: text
    }
  };
}

describe("RunGuidanceStore", () => {
  test("应按点击顺序保存并消费 pending guidance", () => {
    let now = 1000;
    const store = new RunGuidanceStore({ now: () => now++ });

    const first = store.addQueuedDispatch(createDispatch("queued-1", "优先看 Alice 的方案"));
    const second = store.addQueuedDispatch(createDispatch("queued-2", "再保持现有 UI 密度"));

    expect(first.promotedAt).toBe(1000);
    expect(second.promotedAt).toBe(1001);
    expect(store.listPending("thread-a").map((item) => item.text)).toEqual([
      "优先看 Alice 的方案",
      "再保持现有 UI 密度"
    ]);

    const consumed = store.consumePendingGuidance("thread-a");

    expect(consumed).toEqual({
      guidanceIds: ["queued-1", "queued-2"],
      text: "1. 优先看 Alice 的方案\n2. 再保持现有 UI 密度",
      items: [
        {
          id: "queued-1",
          threadId: "thread-a",
          text: "优先看 Alice 的方案",
          createdAt: 100,
          promotedAt: 1000
        },
        {
          id: "queued-2",
          threadId: "thread-a",
          text: "再保持现有 UI 密度",
          createdAt: 100,
          promotedAt: 1001
        }
      ]
    });
    expect(store.listPending("thread-a")).toEqual([]);
    expect(store.consumePendingGuidance("thread-a")).toBeNull();
  });

  test("drainUnconsumedDispatches 应返回未消费 dispatch 并清空 pending guidance", () => {
    const store = new RunGuidanceStore({ now: () => 2000 });
    const first = createDispatch("queued-1", "第一条");
    const second = createDispatch("queued-2", "第二条");

    store.addQueuedDispatch(first);
    store.addQueuedDispatch(second);

    const drained = store.drainUnconsumedDispatches<TestDispatch>("thread-a");

    expect(drained.map((item) => item.input.userMessage)).toEqual(["第一条", "第二条"]);
    expect(store.listPending("thread-a")).toEqual([]);
    expect(store.drainUnconsumedDispatches<TestDispatch>("thread-a")).toEqual([]);
  });

  test("addQueuedDispatch 应保留附件摘要并在 consume 时输出", () => {
    const store = new RunGuidanceStore({ now: () => 3000 });
    const dispatch = createDispatch("queued-rich", "改用方案 B");
    (dispatch as TestDispatch & { attachmentsBrief?: string }).attachmentsBrief = "<file_attachments>方案 B 截图</file_attachments>";

    const guidance = store.addQueuedDispatch(dispatch as never);
    expect(guidance.attachmentsBrief).toContain("方案 B 截图");

    const consumed = store.consumePendingGuidance("thread-a");
    expect(consumed!.attachmentsBrief).toContain("方案 B 截图");
    expect(consumed!.text).toBe("1. 改用方案 B");
  });
});
