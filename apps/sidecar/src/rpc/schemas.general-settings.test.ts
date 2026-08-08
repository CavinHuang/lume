import { describe, expect, test } from "bun:test";
import { clearCacheInputSchema, updateGeneralSettingsInputSchema } from "./schemas";

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

describe("updateGeneralSettingsInputSchema", () => {
  test("agentIsland 部分更新应被保留（不被静默剥除）", () => {
    const parsed = updateGeneralSettingsInputSchema.parse({
      agentIsland: { enabled: false }
    });
    expect(parsed).toEqual({ agentIsland: { enabled: false } });
  });

  test("agentIsland 可选，缺省时不出现在结果中", () => {
    const parsed = updateGeneralSettingsInputSchema.parse({
      agentMessageDisplayMode: "verbose"
    });
    expect(parsed).toEqual({ agentMessageDisplayMode: "verbose" });
    expect(parsed).not.toHaveProperty("agentIsland");
  });
});
