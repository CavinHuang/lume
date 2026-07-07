import { describe, expect, test } from "bun:test";
import { DesktopHostRpcClient, type DesktopHostConnection } from "./desktop-host-client";
import { DesktopHostFrameDecoder, encodeDesktopHostFrame } from "./desktop-host-protocol";

class FakeConnection implements DesktopHostConnection {
  writes: Buffer[] = [];
  dataListener: (chunk: Buffer) => void = () => undefined;
  closeListener: () => void = () => undefined;
  errorListener: (error: Error) => void = () => undefined;

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  onData(listener: (chunk: Buffer) => void): void { this.dataListener = listener; }
  onClose(listener: () => void): void { this.closeListener = listener; }
  onError(listener: (error: Error) => void): void { this.errorListener = listener; }
  destroy(): void { this.closeListener(); }
  receive(message: Record<string, unknown>): void { this.dataListener(encodeDesktopHostFrame(message)); }
  sent(): Record<string, unknown>[] {
    const decoder = new DesktopHostFrameDecoder();
    return this.writes.flatMap((frame) => decoder.push(frame));
  }
}

describe("DesktopHostRpcClient", () => {
  test("authenticates before forwarding calls", async () => {
    const connection = new FakeConnection();
    const client = new DesktopHostRpcClient({
      token: "session-secret",
      connect: async () => connection,
      timeoutMs: 100,
    });

    const start = client.start();
    await Promise.resolve();
    expect(connection.sent()).toEqual([
      { id: 1, method: "system.handshake", params: { token: "session-secret" } },
    ]);
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 1 } });
    await start;

    const call = client.call("list_apps", { includeBackground: false });
    await Promise.resolve();
    expect(connection.sent()[1]).toEqual({
      id: 2,
      method: "list_apps",
      params: { includeBackground: false },
    });
    connection.receive({ id: 2, result: { status: "ok", apps: [] } });
    await expect(call).resolves.toEqual({ status: "ok", apps: [] });
  });

  test("delivers host notifications without treating them as responses", async () => {
    const connection = new FakeConnection();
    const events: unknown[] = [];
    const client = new DesktopHostRpcClient({ token: "token", connect: async () => connection, timeoutMs: 100 });
    client.onNotification((method, params) => events.push({ method, params }));
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 1 } });
    await start;

    connection.receive({ method: "context.event", params: { id: "event-1" } });
    expect(events).toEqual([{ method: "context.event", params: { id: "event-1" } }]);
  });

  test("rejects calls that exceed the timeout", async () => {
    const connection = new FakeConnection();
    const client = new DesktopHostRpcClient({ token: "token", connect: async () => connection, timeoutMs: 5 });
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 1 } });
    await start;
    await expect(client.call("list_windows", {})).rejects.toThrow("timed out");
  });
});
