import { afterEach, describe, expect, test } from "bun:test";
import { classifyAction, createLinkTools } from "./create-link-tools";
import { installLinkRuntimeBootstrap } from "../../../link/link-client";
import { submitToolPermissionDecision } from "../../interruption/tool-permission-session";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  installLinkRuntimeBootstrap({ phase: "offline" });
});

describe("OpenConnector Link tools", () => {
  test("exposes exactly the four governed tools only while online", () => {
    expect(createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {} })).toEqual([]);
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    expect(createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {} }).map((tool) => tool.name)).toEqual([
      "link_list_apps", "link_search_actions", "link_inspect_actions", "link_call_action",
    ]);
  });

  test("risk classification fails closed without explicit read-only metadata", () => {
    expect(classifyAction({ id: "github.list_issues", service: "github", name: "List issues" })).toBe("read");
    expect(classifyAction({ id: "github.create_issue", service: "github", name: "Create issue" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "github.list_and_delete_issues", service: "github", name: "List and delete issues" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "github.listAndDeleteIssues", service: "github", name: "listAndDeleteIssues" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "github.get_and_revoke_token", service: "github", name: "Get and revoke token" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "vendor.export_data", service: "vendor", name: "Export data after list" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "vendor.do_thing", service: "vendor", name: "Do thing" })).toBe("write_or_unknown");
    expect(classifyAction({ id: "vendor.do_thing", service: "vendor", name: "Do thing", readOnly: true })).toBe("read");
  });

  test("requires one-shot approval and reuses an idempotency key for the single transport retry", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    const requests: Request[] = [];
    let postAttempts = 0;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json({ success: true, data: { id: "github.create_issue", service: "github", name: "Create issue" } });
      }
      postAttempts += 1;
      if (postAttempts === 1) throw new TypeError("transport reset");
      return Response.json({ success: true, data: { ok: true } });
    }) as typeof fetch;
    let approvalRequest: Parameters<typeof submitToolPermissionDecision>[0] | undefined;
    const tools = createLinkTools({
      threadId: "thread",
      runId: "run",
      emitToolPermissionRequest: (request) => {
        expect(request.canAllowAlways).toBe(false);
        expect(request.input).toEqual({ service: "github", action: "github.create_issue", connectionName: "work" });
        approvalRequest = { threadId: request.threadId, requestId: request.requestId, decision: "allow_once" };
        submitToolPermissionDecision(approvalRequest);
      },
    });
    await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.create_issue"], connectionName: "work" },
      { cwd: ".", toolUseId: "inspect-1" } as never,
    );
    const result = await tools.find((tool) => tool.name === "link_call_action")!.call(
      { service: "github", action: "github.create_issue", connectionName: "work", input: { title: "A" } },
      { cwd: ".", toolUseId: "mutation-1" } as never,
    );

    expect(approvalRequest).toBeDefined();
    expect(result.is_error).not.toBe(true);
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    const idempotencyKeys = posts.map((request) => request.headers.get("idempotency-key"));
    expect(idempotencyKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(posts.every((request) => request.headers.get("x-oo-connector-alias") === "work")).toBe(true);
    expect(posts.every((request) => request.headers.get("authorization") === "Bearer runtime")).toBe(true);
  });

  test("requires inspection for the exact named account", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    globalThis.fetch = (async () => Response.json({ success: true, data: { id: "github.list_issues", service: "github", name: "List issues" } })) as unknown as typeof fetch;
    const tools = createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {} });
    await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.list_issues"], connectionName: "work" },
      { cwd: ".", toolUseId: "inspect-work" } as never,
    );
    await expect(tools.find((tool) => tool.name === "link_call_action")!.call(
      { service: "github", action: "github.list_issues", connectionName: "personal", input: {} },
      { cwd: ".", toolUseId: "call-personal" } as never,
    )).rejects.toThrow("inspection_required");
  });

  test("limits action calls to two and emits a sanitized authorization signal", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    let active = 0;
    let maximum = 0;
    let callCount = 0;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json({ success: true, data: { id: "github.list_issues", service: "github", name: "List issues" } });
      }
      const attempt = ++callCount;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (attempt === 3) {
        return Response.json({ success: false, errorCode: "connection_not_found", message: "Connect GitHub" }, { status: 401 });
      }
      return Response.json({ success: true, data: { ok: true } });
    }) as typeof fetch;
    const tools = createLinkTools({ threadId: "thread", runId: "run", emitToolPermissionRequest: () => {} });
    await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.list_issues"] },
      { cwd: ".", toolUseId: "inspect-1" } as never,
    );
    const call = tools.find((tool) => tool.name === "link_call_action")!;
    const results = await Promise.all([1, 2, 3].map((index) => call.call(
      { service: "github", action: "github.list_issues", input: {} },
      { cwd: ".", toolUseId: `read-${index}` } as never,
    )));

    expect(maximum).toBe(2);
    expect(results[2]).toMatchObject({
      is_error: true,
      _meta: { link: { kind: "link_authorization_required", service: "github", actionId: "github.list_issues", threadId: "thread", errorCode: "connection_not_found" } },
    });
  });
});
