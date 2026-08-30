/**
 * IAB 后端单元测试:描述符形状、超时先取消(cancel-first)流程、协议闸
 * fail-closed、结果透传与生命周期通知(全部经注入的 fake transport,不走真桥)。
 */
import { describe, expect, test } from "bun:test";

import {
  BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND,
  BROWSER_CAPABILITIES,
  type BrowserCommand,
  type BrowserCommandContext,
  type BrowserCommandResult,
  type BrowserExecuteRequest,
} from "@lume/shared";

import {
  browserCommandTimeoutMs,
  createIabBrowserBackend,
  type BrowserMainTransport,
} from "./iab-backend";

interface RecordedCall {
  request: BrowserExecuteRequest;
  timeoutMs: number;
}

function makeContext(overrides: Partial<BrowserCommandContext> = {}): BrowserCommandContext {
  return {
    requestId: "req-1",
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceKey: "workspace-1",
    browserId: "iab:test",
    browserGeneration: 1,
    clientMode: "desktop-continuous",
    ...overrides,
  };
}

function recordingTransport(
  handle: (call: RecordedCall) => Promise<Record<string, unknown>> | Record<string, unknown>,
): BrowserMainTransport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async execute(request, timeoutMs) {
      const call = { request, timeoutMs };
      calls.push(call);
      return await handle(call);
    },
    isAvailable: () => true,
  };
}

describe("browserCommandTimeoutMs", () => {
  test("playwright/waitFor 系 +2s 余量,其余 30s 基准", () => {
    const base = { method: "list" } as BrowserCommand;
    expect(browserCommandTimeoutMs(base)).toBe(30_000);
    expect(browserCommandTimeoutMs({ method: "navigate", url: "https://example.com/" })).toBe(30_000);
    expect(browserCommandTimeoutMs({ method: "playwright", action: { name: "domSnapshot" } })).toBe(32_000);
    expect(browserCommandTimeoutMs({ method: "playwrightWaitForTimeout", timeoutMs: 10 })).toBe(32_000);
    expect(browserCommandTimeoutMs({ method: "waitFor", selector: "a" })).toBe(32_000);
    // 基准可覆盖(playwright 系仍 +2s)
    expect(browserCommandTimeoutMs(base, 5_000)).toBe(5_000);
    expect(browserCommandTimeoutMs({ method: "playwright", action: { name: "domSnapshot" } }, 5_000)).toBe(7_000);
  });
});

describe("IAB 后端描述符", () => {
  test("ZCode 形状:id 前缀/generation/type/capabilities/overrides/provider", () => {
    const backend = createIabBrowserBackend({ uuid: () => "fixed-uuid", now: () => 1234 });
    const descriptor = backend.descriptor;
    expect(descriptor.id).toBe("iab:fixed-uuid");
    expect(descriptor.generation).toBe(1234);
    expect(descriptor.type).toBe("iab");
    expect(descriptor.name).toBe("Lume In-app Browser");
    expect(descriptor.capabilities.browser).toEqual(BROWSER_CAPABILITIES);
    expect(descriptor.capabilities.tab).toEqual([]);
    for (const override of BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND.iab) {
      expect(descriptor.apiSupportOverrides).toContain(override);
    }
    expect(descriptor.metadata.provider).toBe("lume-desktop-iab");
  });
});

describe("命令执行", () => {
  test("结果透传:ok 结果原样返回(过 zod 骨架校验)", async () => {
    const transport = recordingTransport(() => ({ ok: true, tabs: [] }));
    const backend = createIabBrowserBackend({ transport });
    const result = await backend.execute({ context: makeContext(), command: { method: "list" } });
    expect(result.ok).toBe(true);
    expect((result as { tabs?: unknown[] }).tabs).toEqual([]);
  });

  test("非法结果信封折进 execution_error,不外泄传输噪音", async () => {
    const transport = recordingTransport(() => ({ ok: "yes" }));
    const backend = createIabBrowserBackend({ transport });
    const result = await backend.execute({ context: makeContext(), command: { method: "list" } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("execution_error");
  });

  test("传输拒绝(非超时)折进 backend_unavailable", async () => {
    const transport = recordingTransport(() => {
      throw Object.assign(new Error("bridge gone"), { code: "backend_unavailable" });
    });
    const backend = createIabBrowserBackend({ transport });
    const result = await backend.execute({ context: makeContext(), command: { method: "list" } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_unavailable");
    expect(result.error?.message).toContain("bridge gone");
  });
});

describe("超时策略(cancel-first)", () => {
  test("副作用命令超时:先补发 cancelRequest(新 requestId)再返回 timeout + uncertain", async () => {
    const transport = recordingTransport((call) => {
      if (call.request.command.method === "cancelRequest") return { ok: true };
      throw Object.assign(new Error("browser request timed out"), { code: "timeout" });
    });
    const backend = createIabBrowserBackend({ transport });
    const context = makeContext();
    const result = await backend.execute({ context, command: { method: "navigate", url: "https://example.com/" } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.sideEffect).toBe("uncertain");
    expect(transport.calls).toHaveLength(2);
    const cancel = transport.calls[1]!;
    expect(cancel.request.command).toEqual({ method: "cancelRequest", requestId: "req-1" });
    // 取消用独立 requestId,避免 duplicate_request_id;scope 成分保持原值。
    expect(cancel.request.context.requestId).not.toBe("req-1");
    expect(cancel.request.context.sessionId).toBe(context.sessionId);
    expect(cancel.request.context.browserId).toBe(context.browserId);
  });

  test("只读命令超时:同样先取消,但 sideEffect 标 none", async () => {
    const transport = recordingTransport((call) => {
      if (call.request.command.method === "cancelRequest") return { ok: true };
      throw Object.assign(new Error("browser request timed out"), { code: "timeout" });
    });
    const backend = createIabBrowserBackend({ transport });
    const result = await backend.execute({ context: makeContext(), command: { method: "list" } });
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.sideEffect).toBe("none");
  });

  test("超时基线按命令透传给传输层(playwright +2s)", async () => {
    const transport = recordingTransport((call) => {
      if (call.request.command.method === "playwright") {
        throw Object.assign(new Error("browser request timed out"), { code: "timeout" });
      }
      return { ok: true };
    });
    const backend = createIabBrowserBackend({ transport });
    await backend.execute({
      context: makeContext(),
      command: { method: "playwright", action: { name: "domSnapshot" } },
    });
    expect(transport.calls[0]?.timeoutMs).toBe(32_000);
    expect(transport.calls[0]?.request.command.method).toBe("playwright");
  });
});

describe("协议版本闸", () => {
  test("对端声明不相容范围 → incompatible_protocol,且后续命令 fail closed", async () => {
    const transport = recordingTransport(() => ({ ok: true, protocolVersion: 1, minSupported: 2, maxSupported: 9 }));
    const backend = createIabBrowserBackend({ transport });
    const command: BrowserCommand = { method: "list" };

    const first = await backend.execute({ context: makeContext(), command });
    expect(first.ok).toBe(false);
    expect(first.error?.code as string).toBe("incompatible_protocol");
    expect(first.error?.message).toContain("1..1");

    const second = await backend.execute({ context: makeContext(), command });
    expect(second.error?.code as string).toBe("incompatible_protocol");
    expect(transport.calls).toHaveLength(1); // 第二次不再打穿传输
  });

  test("对端未声明协议范围(旧版 main)→ 放行", async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    const backend = createIabBrowserBackend({ transport });
    const result = await backend.execute({ context: makeContext(), command: { method: "list" } });
    expect(result.ok).toBe(true);
  });
});

describe("turn 生命周期通知", () => {
  test("turnEnded/closeSession 携带后端补全的归属上下文", async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    const backend = createIabBrowserBackend({ transport, uuid: () => "life-uuid", now: () => 7 });

    await backend.turnEnded({ sessionId: "s1", workspaceKey: "w1", turnId: "turn-9" });
    await backend.closeSession({ sessionId: "s1", workspaceKey: "w1" });

    expect(transport.calls).toHaveLength(2);
    const [turn, close] = [transport.calls[0]!, transport.calls[1]!];
    expect(turn.request.command).toEqual({ method: "turnEnded", turnId: "turn-9" });
    expect(turn.request.context.sessionId).toBe("s1");
    expect(turn.request.context.browserId).toBe("iab:life-uuid");
    expect(turn.request.context.browserGeneration).toBe(7);
    expect(turn.request.context.clientMode).toBe("desktop-continuous");
    expect(close.request.command).toEqual({ method: "closeSession" });
  });

  test("通知失败静默:main 不在场时不抛出", async () => {
    const transport = recordingTransport(() => {
      throw Object.assign(new Error("disconnected"), { code: "backend_unavailable" });
    });
    const backend = createIabBrowserBackend({ transport });
    await expect(backend.turnEnded({ sessionId: "s1", workspaceKey: "w1" })).resolves.toBeUndefined();
    await expect(backend.closeSession({ sessionId: "s1", workspaceKey: "w1" })).resolves.toBeUndefined();
  });
});
