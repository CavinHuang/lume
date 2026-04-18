import { describe, expect, test } from "bun:test";
import { clearCacheInputSchema } from "./schemas";

describe("clearCacheInputSchema", () => {
  test("应拒绝 legacy frontend/preview cache keys", () => {
    expect(() => clearCacheInputSchema.parse({
      frontendTemp: true,
      logs: true
    })).toThrow();

    expect(() => clearCacheInputSchema.parse({
      previewRender: true
    })).toThrow();
  });

  test("应仅接受 logs 作为 sidecar 清理输入", () => {
    expect(clearCacheInputSchema.parse({
      logs: true
    })).toEqual({
      logs: true
    });
  });
});
