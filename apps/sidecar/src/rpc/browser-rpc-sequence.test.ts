import { describe, expect, test } from "bun:test";
import { browserRpcErrorFromPayload, classifyBrowserRpcResponse } from "./browser-rpc-sequence";

describe("classifyBrowserRpcResponse（#156 序列号单调判定）", () => {
  test("正常路径：MAC 有效且序号 = 当前 +1 → advance", () => {
    expect(classifyBrowserRpcResponse(1, true, 0)).toBe("advance");
    expect(classifyBrowserRpcResponse(5, true, 4)).toBe("advance");
  });

  test("毒化治愈：超时后跳号到达的合法响应（序号 > 当前 +1）→ advance", () => {
    // 请求 A(seq1) 超时被吞后，后续请求的响应序号 3 永远满足不了旧严格 +1 规则（1+1=2）
    expect(classifyBrowserRpcResponse(3, true, 1)).toBe("advance");
  });

  test("重放拒绝：序号 ≤ 当前值 → reject-pending", () => {
    expect(classifyBrowserRpcResponse(1, true, 1)).toBe("reject-pending");
    expect(classifyBrowserRpcResponse(0, true, 3)).toBe("reject-pending");
  });

  test("MAC 失败：任何序号都拒绝", () => {
    expect(classifyBrowserRpcResponse(9, false, 0)).toBe("reject-pending");
  });
});

describe("browserRpcErrorFromPayload（#252 错误码传播）", () => {
  test("保留 Desktop 返回的稳定错误码", () => {
    const error = browserRpcErrorFromPayload({ code: "actionability_failed" });

    expect(error.code).toBe("actionability_failed");
    expect(error.message).toBe("actionability_failed");
  });

  test("无效错误载荷安全退化为 browser_internal_error", () => {
    const error = browserRpcErrorFromPayload(undefined);

    expect(error.code).toBe("browser_internal_error");
    expect(error.message).toBe("browser_internal_error");
  });
});
