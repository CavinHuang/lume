import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createProcessRpcTransport } from "./process-transport";

describe("createProcessRpcTransport 行缓冲（#154 大小上限）", () => {
  test("正常分帧消息逐行送达", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createProcessRpcTransport({ input, output, parentPort: null });
    const received: string[] = [];
    transport.listen((line) => received.push(line));
    input.write('{"id":1}\n{"id":2}\r\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual(['{"id":1}', '{"id":2}']);
  });

  test("单行超过上限断开输入流且不再投递", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createProcessRpcTransport({ input, output, parentPort: null, maxMessageBytes: 16 });
    const received: string[] = [];
    transport.listen((line) => received.push(line));
    const destroyed = new Promise<void>((resolve) => input.once("close", () => resolve()));

    input.write("a".repeat(17));
    await destroyed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([]);
  });
});
