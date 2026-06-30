import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createProcessRpcTransport } from "./process-transport";

describe("createProcessRpcTransport", () => {
  test("uses Electron parentPort without newline framing", () => {
    const parentPort = new FakeParentPort();
    const received: string[] = [];
    const transport = createProcessRpcTransport({ parentPort });

    transport.listen((message) => received.push(message));
    transport.send('{"id":1,"result":{"ok":true}}');
    parentPort.emit("message", { data: '{"id":2,"method":"healthcheck"}' });

    expect(parentPort.sent).toEqual(['{"id":1,"result":{"ok":true}}']);
    expect(received).toEqual(['{"id":2,"method":"healthcheck"}']);
  });

  test("keeps newline-delimited stdio compatibility", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString();
    });
    const transport = createProcessRpcTransport({ input, output, parentPort: null });

    const receivedLine = new Promise<void>((resolve) => {
      transport.listen((message) => {
        received.push(message);
        resolve();
      });
    });
    transport.send('{"id":1,"result":{"ok":true}}');
    input.write('{"id":2,"method":"healthcheck"}\n');
    await receivedLine;

    expect(written).toBe('{"id":1,"result":{"ok":true}}\n');
    expect(received).toEqual(['{"id":2,"method":"healthcheck"}']);
  });
});

class FakeParentPort extends EventEmitter {
  readonly sent: string[] = [];

  postMessage(message: string): void {
    this.sent.push(message);
  }
}
