// apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts
import { describe, expect, test } from "bun:test";
import { createReverseRpcRenderClient } from "./reverse-rpc-render-client.js";

function harness() {
  const sent: { method: string; params: any }[] = [];
  const sendNotification = (method: string, params: unknown) => { sent.push({ method, params: params as any }); };
  const client = createReverseRpcRenderClient({ sendNotification, timeoutMs: 50 });
  return { sent, client };
}

describe("createReverseRpcRenderClient", () => {
  test("renderUrl sends render:request with reqId and awaits matching render:result", async () => {
    const { sent, client } = harness();
    const p = client.renderUrl("https://example.com", { waitForSelector: "#main" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("render:request");
    const reqId = sent[0]!.params.reqId;
    expect(sent[0]!.params.url).toBe("https://example.com");
    expect(sent[0]!.params.options?.waitForSelector).toBe("#main");

    client.handleRenderResult({ reqId, html: "<html>RENDERED</html>", finalUrl: "https://example.com", status: 200 });
    const out = await p;
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.html).toContain("RENDERED");
  });

  test("renderUrl resolves to failure when result carries error", async () => {
    const { sent, client } = harness();
    const p = client.renderUrl("https://example.com");
    const reqId = sent[0]!.params.reqId;
    client.handleRenderResult({ reqId, error: { code: "render_timeout", message: "timed out" } });
    const out = await p;
    expect(out.ok).toBe(false);
  });

  test("renderUrl rejects on timeout when no result arrives", async () => {
    const { client } = harness();
    const out = await client.renderUrl("https://example.com");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("render_timeout");
  });

  test("unknown reqId result is ignored", async () => {
    const { client } = harness();
    expect(() => client.handleRenderResult({ reqId: "nope", html: "x" })).not.toThrow();
  });
});
