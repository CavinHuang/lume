import { describe, expect, test } from "bun:test";

const natives = await import("./index.ts");

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
});
