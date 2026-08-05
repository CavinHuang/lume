import { afterEach, describe, expect, test } from "bun:test";
import {
  installLinkRuntimeBootstrap,
  linkAdminRequest,
} from "./link-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  installLinkRuntimeBootstrap({ phase: "offline" });
});

describe("Link local HTTP boundary", () => {
  test("rejects non-loopback, query-bearing, and low-port bootstrap origins", () => {
    for (const origin of [
      "https://127.0.0.1:51234",
      "http://localhost:51234",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:51234/?token=leak",
    ]) {
      expect(() => installLinkRuntimeBootstrap({ phase: "online", origin, adminToken: "admin", runtimeToken: "runtime" })).toThrow("invalid_link_bootstrap");
    }
  });

  test("pins requests to the installed origin and prevents authorization override", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin-only", runtimeToken: "runtime-only" });
    let observed: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      observed = new Request(input, init);
      return Response.json([]);
    }) as typeof fetch;

    await linkAdminRequest("/api/providers", { headers: { authorization: "Bearer renderer-value" } });
    expect(observed?.url).toBe("http://127.0.0.1:51234/api/providers");
    expect(observed?.headers.get("authorization")).toBe("Bearer admin-only");
    expect(observed?.redirect).toBe("error");

    await expect(linkAdminRequest("https://example.test/api/providers")).rejects.toThrow("invalid_link_request_path");
  });
});
