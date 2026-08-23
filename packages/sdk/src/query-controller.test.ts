import { describe, expect, test } from "bun:test";
import { QueryController } from "./query-controller.js";

describe("QueryController input streaming", () => {
  test("async iterable 输入源抛错时错误作为迭代器错误进入消息流", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    async function* source(): AsyncGenerator<string> {
      yield "first";
      throw new Error("input source exploded");
    }

    const consumed: string[] = [];
    const runner = async function* (inputs: AsyncIterable<string>) {
      for await (const item of inputs) {
        consumed.push(item);
      }
    };

    const controller = new QueryController(
      runner,
      source(),
    );

    try {
      const drain = async () => {
        for await (const _event of controller) {
          // drain
        }
      };
      await expect(drain()).rejects.toThrow("input source exploded");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(consumed).toEqual(["first"]);
    expect(unhandled).toHaveLength(0);
  });

  test("标量初始输入照常投递并关闭输入队列", async () => {
    const runner = async function* (inputs: AsyncIterable<string>) {
      for await (const item of inputs) {
        yield { type: "user", message: item };
      }
      yield { type: "system", subtype: "done" };
    };

    const controller = new QueryController(runner, "hello");
    const events: Array<Record<string, unknown>> = [];
    for await (const event of controller) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.message).toBe("hello");
    expect((controller as any).queue.closed).toBe(true);
  });
});
