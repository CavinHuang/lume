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

  test("输入流关闭触发 onClose（#611 断连批量 reject 的钩子）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createProcessRpcTransport({ input, output, parentPort: null });
    const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()));

    // resume 让流进入 flowing 模式，end() 后 'end'/'close' 才会触发
    input.resume();
    input.end();
    await closed;
    input.destroy();
  });

  test("多字节字符劈在 chunk 边界不产出 U+FFFD（#552 stdio UTF-8 劈裂）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createProcessRpcTransport({ input, output, parentPort: null });
    const received: string[] = [];
    transport.listen((line) => received.push(line));

    // 中文行劈成两半：前半以不完整多字节序列结尾
    const line = JSON.stringify({ method: "t", params: { text: "中文消息测试" } });
    const raw = Buffer.from(`${line}\n`, "utf8");
    const splitAt = Buffer.byteLength(line, "utf8") - 3; // 劈在最后一个汉字的中间
    input.write(raw.subarray(0, splitAt));
    input.write(raw.subarray(splitAt));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).params.text).toBe("中文消息测试");
  });
});
