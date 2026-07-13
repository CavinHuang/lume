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
  test("retries startup connection failures until the desktop host socket is ready", async () => {
    const connection = new FakeConnection();
    let attempts = 0;
    let clock = 0;
    const client = new DesktopHostRpcClient({
      token: "token",
      connect: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("socket not ready");
        return connection;
      },
      connectTimeoutMs: 500,
      retryDelayMs: 50,
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      timeoutMs: 100,
    });

    const start = client.start();
    for (let index = 0; index < 10 && attempts < 3; index += 1) {
      await Promise.resolve();
    }
    for (let index = 0; index < 10 && connection.sent().length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(connection.sent()).toHaveLength(1);
    expect(attempts).toBe(3);
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });

    await expect(start).resolves.toBeUndefined();
  });

  test("stops retrying at the startup connection deadline", async () => {
    let attempts = 0;
    let clock = 0;
    const client = new DesktopHostRpcClient({
      token: "token",
      connect: async () => {
        attempts += 1;
        throw new Error(`socket not ready ${attempts}`);
      },
      connectTimeoutMs: 100,
      retryDelayMs: 50,
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
    });
    const start = client.start();
    for (let index = 0; index < 20 && attempts < 4; index += 1) {
      await Promise.resolve();
    }
    await expect(start).rejects.toThrow("socket not ready 4");
    expect(attempts).toBe(4);
  });

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
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });
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

  test("classifies host JSON-RPC errors separately from connection failures", async () => {
    const connection = new FakeConnection();
    const client = new DesktopHostRpcClient({
      token: "token",
      connect: async () => connection,
      timeoutMs: 100,
    });
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });
    await start;

    const call = client.call("click", {});
    await Promise.resolve();
    connection.receive({
      id: 2,
      error: { code: -32000, message: "stale_target: use the latest state.window" },
    });
    const error = await call.catch((value) => value);

    expect(error).toMatchObject({
      name: "DesktopHostRequestError",
      code: -32000,
      message: "stale_target: use the latest state.window",
    });
  });

  test("delivers host notifications without treating them as responses", async () => {
    const connection = new FakeConnection();
    const events: unknown[] = [];
    const client = new DesktopHostRpcClient({ token: "token", connect: async () => connection, timeoutMs: 100 });
    client.onNotification((method, params) => events.push({ method, params }));
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });
    await start;

    connection.receive({ method: "context.event", params: { id: "event-1" } });
    expect(events).toEqual([{ method: "context.event", params: { id: "event-1" } }]);
  });

  test("rejects calls that exceed the timeout", async () => {
    const connection = new FakeConnection();
    const client = new DesktopHostRpcClient({ token: "token", connect: async () => connection, timeoutMs: 5 });
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });
    await start;
    await expect(client.call("list_windows", {})).rejects.toThrow("timed out");
  });

  test("rejects an incompatible desktop host protocol version", async () => {
    const connection = new FakeConnection();
    const client = new DesktopHostRpcClient({ token: "token", connect: async () => connection, timeoutMs: 100 });
    const start = client.start();
    await Promise.resolve();
    connection.receive({ id: 1, result: { status: "ok", protocolVersion: 2 } });
    await expect(start).rejects.toThrow("protocol version mismatch: expected 3, received 2; restart Lume");
  });
});
