import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageGenTools } from "./create-image-gen-tools";

let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-tools-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
  writeFileSync(join(tempConfigDir, "lume.yaml"), "version: 1\n");
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = prevConfigDir;
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("create-image-gen-tools", () => {
  test("注册 image_gen 与 list_image_models 两个工具", () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("image_gen");
    expect(names).toContain("list_image_models");
  });

  test("image_gen 缺 prompt 报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call({}, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("prompt");
  });

  test("image_gen 仅传 mask_image（无 reference_image）报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call(
      { prompt: "x", mask_image: "files/m.png" },
      { cwd: "/tmp" } as never,
    );
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("mask_image");
  });

  test("image_gen 未配置模型时报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call({ prompt: "a cat" }, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("未配置");
  });

  test("list_image_models 返回空模型列表（未配置）", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "list_image_models")!;
    const result = await tool.call({}, { cwd: "/tmp" } as never);
    const parsed = JSON.parse(String(result.content));
    expect(parsed.models).toEqual([]);
  });
});
