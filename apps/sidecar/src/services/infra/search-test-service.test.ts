import { describe, expect, test } from "bun:test";
import { createSearchBackendTester } from "./search-test-service";

describe("search-test-service", () => {
  test("guanlan 后端可用时返回成功", async () => {
    const testSearchBackend = createSearchBackendTester(async () => ({ ok: true }));

    const result = await testSearchBackend({ provider: "guanlan" });

    expect(result).toEqual({ ok: true, provider: "guanlan" });
  });

  test("guanlan 后端不可用时返回错误原因", async () => {
    const testSearchBackend = createSearchBackendTester(async () => ({
      ok: false,
      error: "未找到 Python"
    }));

    const result = await testSearchBackend({ provider: "guanlan" });

    expect(result).toEqual({
      ok: false,
      provider: "guanlan",
      error: "未找到 Python"
    });
  });
});
