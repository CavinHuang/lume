import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToolMetadata } from "./tool-metadata";
import { createLumeRuntimeTools } from "./create-lume-tools";
import { registerRealAgentThreadStore } from "../agent-thread-store-test-adapter";

registerRealAgentThreadStore();

let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-wiring-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = prevConfigDir;
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("image-gen wiring", () => {
  test("image_gen 元数据为 execute/medium，plan 模式禁用", () => {
    expect(getToolMetadata("image_gen")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false,
    });
  });

  test("list_image_models 元数据为 read/low，plan 模式允许", () => {
    expect(getToolMetadata("list_image_models")).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true,
    });
  });

  test("createLumeRuntimeTools 装配两个工具并加入 availableToolNames", () => {
    const { customTools, availableToolNames } = createLumeRuntimeTools({
      threadId: "t",
      workspaceSlug: "ws",
      includeCitations: false,
      emitAskUserQuestion: () => {},
      emitToolPermissionRequest: () => {},
    });
    expect(customTools.map((t) => t.name)).toContain("image_gen");
    expect(customTools.map((t) => t.name)).toContain("list_image_models");
    expect(availableToolNames).toContain("image_gen");
    expect(availableToolNames).toContain("list_image_models");
  });
});
