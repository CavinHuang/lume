import { describe, expect, test } from "bun:test";
import { PluginMarketError } from "./plugin-market-errors";
import { readBoundedBody, REMOTE_BODY_GUARD_FOR_TEST } from "./plugin-market-service";

// #525-10/11 回归钉死:远程 body 必须经分块上限消费(chunked 无
// content-length 时 content-length 前检失效,arrayBuffer 后才查=最坏整体入内存),
// 且 requestRemote 的超时 guard 在 body 读完时清除(signal 贯穿整个响应周期)。

function streamResponse(chunks: Uint8Array[]): Response {
  const queue = [...chunks];
  const stream = new (globalThis as { ReadableStream: new (source: object) => unknown }).ReadableStream({
    pull(controller: { enqueue: (chunk: Uint8Array) => void; close: () => void }) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
  return new Response(stream as ReadableStream<Uint8Array>, { status: 200 });
}

describe("readBoundedBody 分块上限与 guard 清理 (#525)", () => {
  test("正常分块全部读取", async () => {
    const response = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const bytes = await readBoundedBody(response);
    expect(bytes).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("累计字节超上限即中止并抛 oversize 错误", async () => {
    const response = streamResponse([
      new Uint8Array(600),
      new Uint8Array(600),
      new Uint8Array(600),
    ]);
    await expect(readBoundedBody(response, 1000)).rejects.toThrow(PluginMarketError);
  });

  test("oversize 工厂决定错误码(tarball 场景 install_failed)", async () => {
    const response = streamResponse([new Uint8Array(64)]);
    try {
      await readBoundedBody(response, 32, () => new PluginMarketError("install_failed", "归档超限"));
      expect.unreachable();
    } catch (error) {
      expect((error as PluginMarketError).code).toBe("install_failed");
    }
  });

  test("body 读完清除超时 guard(不泄漏定时器句柄)", async () => {
    let cleared = false;
    const fakeTimer = setTimeout(() => undefined, 60_000) as unknown as ReturnType<typeof setTimeout>;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      if (timer === fakeTimer) cleared = true;
      return originalClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    try {
      const response = streamResponse([new Uint8Array([9])]);
      (response as unknown as Record<symbol, unknown>)[REMOTE_BODY_GUARD_FOR_TEST] = { timer: fakeTimer };
      await readBoundedBody(response);
      expect(cleared).toBe(true);
    } finally {
      originalClearTimeout(fakeTimer);
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
