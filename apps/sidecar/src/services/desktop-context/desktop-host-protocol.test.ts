import { describe, expect, test } from "bun:test";
import { DesktopHostFrameDecoder, encodeDesktopHostFrame } from "./desktop-host-protocol";

describe("desktop host framing", () => {
  test("encodes JSON with a four-byte little-endian length prefix", () => {
    const frame = encodeDesktopHostFrame({ id: 1, method: "list_apps", params: {} });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual({
      id: 1,
      method: "list_apps",
      params: {},
    });
  });

  test("decodes split and coalesced frames without losing bytes", () => {
    const decoder = new DesktopHostFrameDecoder();
    const first = encodeDesktopHostFrame({ id: 1, result: { status: "ok" } });
    const second = encodeDesktopHostFrame({ method: "context.event", params: { id: "event-1" } });

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { id: 1, result: { status: "ok" } },
      { method: "context.event", params: { id: "event-1" } },
    ]);
  });

  test("rejects frames larger than the configured limit", () => {
    const decoder = new DesktopHostFrameDecoder(8);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(9, 0);
    expect(() => decoder.push(header)).toThrow("desktop host frame exceeds 8 bytes");
  });
});
