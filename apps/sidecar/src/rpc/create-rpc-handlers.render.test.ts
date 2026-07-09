import { describe, expect, test } from "bun:test";
import { createRpcHandlers } from "./create-rpc-handlers.js";

describe("render:result handler", () => {
  test("forwards params to renderClient.handleRenderResult and returns {ok:true}", async () => {
    const seen: any[] = [];
    const handlers = createRpcHandlers({
      writeNotification: () => {},
      renderClient: { handleRenderResult: (p: unknown) => seen.push(p) }
    } as any);
    const h = handlers["render:result"];
    expect(h).toBeDefined();
    const out = await h!({ reqId: "r1", html: "<x>", finalUrl: "https://a.com" });
    expect(out).toEqual({ ok: true });
    expect(seen[0]).toEqual({ reqId: "r1", html: "<x>", finalUrl: "https://a.com" });
  });

  test("absent renderClient => no render:result handler registered", () => {
    const handlers = createRpcHandlers({ writeNotification: () => {} } as any);
    expect(handlers["render:result"]).toBeUndefined();
  });
});
