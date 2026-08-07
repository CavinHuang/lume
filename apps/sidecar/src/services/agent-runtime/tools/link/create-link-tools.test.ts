import { afterEach, describe, expect, test } from "bun:test";
import { classifyAction, createLinkTools } from "./create-link-tools";
import { installLinkRuntimeBootstrap, type McpLinkPayload } from "../../../link/link-client";
import { submitToolPermissionDecision } from "../../interruption/tool-permission-session";

afterEach(() => {
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

  test("requires one-shot approval and routes the call through the MCP execute_action tool", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcpCaller = async (name: string, args: Record<string, unknown>): Promise<McpLinkPayload> => {
      mcpCalls.push({ name, args });
      if (name === "get_action_guide") return { ok: true, data: {} };
      if (name === "execute_action") return { ok: true, data: { ok: true } };
      return { ok: false, error: { code: "unhandled", message: `unhandled ${name}` } };
    };
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
      mcpCaller,
    });
    await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.create_issue"], connectionName: "work" },
      { cwd: ".", toolUseId: "inspect-1" } as never,
    );
    const callResult = await tools.find((tool) => tool.name === "link_call_action")!.call(
      { service: "github", action: "github.create_issue", connectionName: "work", input: { title: "A" } },
      { cwd: ".", toolUseId: "mutation-1" } as never,
    );

    expect(approvalRequest).toBeDefined();
    expect(callResult.is_error).not.toBe(true);
    const executeCalls = mcpCalls.filter((call) => call.name === "execute_action");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]!.args).toEqual({ actionId: "github.create_issue", input: { title: "A" }, connectionName: "work" });
  });

  test("requires inspection for the exact named account", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    const mcpCaller = async (name: string): Promise<McpLinkPayload> => {
      if (name === "get_action_guide") return { ok: true, data: {} };
      return { ok: true, data: { ok: true } };
    };
    const tools = createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {}, mcpCaller });
    await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.list_issues"], connectionName: "work" },
      { cwd: ".", toolUseId: "inspect-work" } as never,
    );
    await expect(tools.find((tool) => tool.name === "link_call_action")!.call(
      { service: "github", action: "github.list_issues", connectionName: "personal", input: {} },
      { cwd: ".", toolUseId: "call-personal" } as never,
    )).rejects.toThrow("inspection_required");
  });

  test("inspect carries the action guide markdown and derives identity from actionId", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    const guide = {
      capability: { requiredScopes: ["repo:issue"], providerPermissions: ["issues:write"] },
      markdown: "## Input Parameters\n\n| Name | Required | Type |\n| --- | --- | --- |\n| title | yes | string |\n",
    };
    const mcpCaller = async (name: string): Promise<McpLinkPayload> => {
      if (name === "get_action_guide") return { ok: true, data: guide };
      return { ok: false, error: { code: "unhandled", message: `unhandled ${name}` } };
    };
    const tools = createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {}, mcpCaller });
    const inspectResult = await tools.find((tool) => tool.name === "link_inspect_actions")!.call(
      { actions: ["github.create_issue"] },
      { cwd: ".", toolUseId: "inspect-1" } as never,
    );
    const detail = JSON.parse((inspectResult as { content: string }).content)[0];

    expect(detail).toMatchObject({
      id: "github.create_issue",
      service: "github",
      name: "create_issue",
      markdown: guide.markdown,
      requiredScopes: ["repo:issue"],
      providerPermissions: ["issues:write"],
      lumeRisk: "write_or_unknown",
    });
  });

  test("limits action calls to two and emits a sanitized authorization signal", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    let active = 0;
    let maximum = 0;
    let execCount = 0;
    const mcpCaller = async (name: string): Promise<McpLinkPayload> => {
      if (name === "get_action_guide") return { ok: true, data: {} };
      if (name === "execute_action") {
        execCount += 1;
        const attempt = execCount;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        if (attempt === 3) return { ok: false, error: { code: "connection_not_found", message: "Connect GitHub" } };
        return { ok: true, data: { ok: true } };
      }
      return { ok: false, error: { code: "unhandled", message: `unhandled ${name}` } };
    };
    const tools = createLinkTools({ threadId: "thread", runId: "run", emitToolPermissionRequest: () => {}, mcpCaller });
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
