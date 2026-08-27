import { describe, expect, test } from "bun:test";

const natives = await import("./index.ts");

const nativeReady = natives.isNativeAvailable();

describe("@lume/natives loader contract", () => {
  test("reports diagnostics without throwing", () => {
    const diagnostics = natives.getNativeDiagnostics();

    expect(typeof diagnostics.available).toBe("boolean");
    expect(diagnostics.binaryPath === null || diagnostics.binaryPath.endsWith(".node")).toBe(true);
    expect(diagnostics.error === null || typeof diagnostics.error === "string").toBe(true);
    expect(Array.isArray(diagnostics.capabilities)).toBe(true);
  });

  test("does not expose Rust logger bindings", () => {
    expect("initLogger" in natives).toBe(false);
    expect("emitLog" in natives).toBe(false);
  });

  test("exposes search and cache invalidation API wrappers", () => {
    expect(typeof natives.nativeHasMatch).toBe("function");
    expect(typeof natives.invalidateFsScanCache).toBe("function");
  });

  // #763：无换行同构长游程曾令 tiktoken-rs 递归 Rust 栈溢出 panic（进程级
  // 致命，JS catch 兜不住）。护栏分块后必须线性完成——旧直连实现（1MiB 单行）
  // 在此必超时显形。natives 缺席时包装层返回 null，跳过。
  test.skipIf(!nativeReady)("countStringTokens survives >256KB newline-free run without panic (#763)", () => {
    const text = "a".repeat(1024 * 1024);
    const start = performance.now();
    const count = natives.countStringTokens(text);
    const elapsedMs = performance.now() - start;
    expect(count).toBeGreaterThan(100_000);
    expect(elapsedMs).toBeLessThan(20_000); // 分块后实测 ~2.5s；旧实现 ~10min 冻结
  }, 30_000);

  test.skipIf(!nativeReady)("guard chunks array elements too — long element cannot bypass via string[] (#763)", () => {
    const result = natives.countTokens({ text: ["x".repeat(512 * 1024), "short"] });
    expect(result?.count ?? 0).toBeGreaterThan(50_000);
  }, 30_000);

  test.skipIf(!nativeReady)("short-input counting unchanged by the guard", () => {
    expect(natives.countStringTokens("hello world")).toBeGreaterThan(0);
    expect(natives.countStringTokens("")).toBe(0);
    expect(natives.countTokens({ text: ["a", "b"] })?.count).toBe(
      natives.countStringTokens("a") + natives.countStringTokens("b"),
    );
  });
});
