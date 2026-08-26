import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToolMetadata } from "./tool-metadata";
import { createLumeRuntimeTools } from "./create-lume-tools";

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

  test("配置了图像生成模型时 createLumeRuntimeTools 装配两个工具", () => {
    // 门控（#539）：仅在 models.imageGeneration.priorityModelRefs 非空时注入
    mkdirSync(tempConfigDir, { recursive: true });
    writeFileSync(
      join(tempConfigDir, "lume.yaml"),
      ["models:", "  imageGeneration:", "    priorityModelRefs:", '      - "img-model-1"'].join("\n"),
      "utf-8",
    );
    const { customTools } = createLumeRuntimeTools({
      threadId: "t",
      workspaceSlug: "ws",
      includeCitations: false,
      emitAskUserQuestion: () => {},
      emitToolPermissionRequest: () => {},
    });
    const names = customTools.map((t) => t.name);
    expect(names).toContain("image_gen");
    expect(names).toContain("list_image_models");
  });

  test("未配置图像生成模型时整族不注入（#539）", () => {
    const { customTools } = createLumeRuntimeTools({
      threadId: "t",
      workspaceSlug: "ws",
      includeCitations: false,
      emitAskUserQuestion: () => {},
      emitToolPermissionRequest: () => {},
    });
    const names = customTools.map((t) => t.name);
    expect(names).not.toContain("image_gen");
    expect(names).not.toContain("list_image_models");
  });
});
