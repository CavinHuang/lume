import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUILTIN_DEFAULT_ID } from "@lume/shared";
import { getSystemPromptsPath } from "../config-paths";
import {
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultPrompt,
  updateAppendSetting,
  updateSystemPrompt
} from "./system-prompt-manager";

describe("system-prompt-manager", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-system-prompt-manager-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应返回默认配置并自动写入配置文件", () => {
    const config = getSystemPromptConfig();
    expect(config.version).toBe(1);
    expect(config.defaultPromptId).toBe(BUILTIN_DEFAULT_ID);
    expect(config.appendDateTimeAndUserName).toBeTrue();
    expect(config.prompts.length).toBe(1);
    expect(config.prompts[0]?.id).toBe(BUILTIN_DEFAULT_ID);
    expect(existsSync(getSystemPromptsPath())).toBeTrue();
  });

  test("应支持提示词 create/update/delete + default 回退", () => {
    const created = createSystemPrompt({
      name: "代码助手",
      content: "请优先给出最小可行改动"
    });
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.isBuiltin).toBeFalse();

    const updated = updateSystemPrompt(created.id, {
      name: "代码助手-v2",
      content: "请先给结论，再给步骤"
    });
    expect(updated.name).toBe("代码助手-v2");
    expect(updated.content).toContain("先给结论");

    setDefaultPrompt(created.id);
    let config = getSystemPromptConfig();
    expect(config.defaultPromptId).toBe(created.id);

    deleteSystemPrompt(created.id);
    config = getSystemPromptConfig();
    expect(config.defaultPromptId).toBe(BUILTIN_DEFAULT_ID);
    expect(config.prompts.some((item) => item.id === created.id)).toBeFalse();
  });

  test("应支持更新 append 开关", () => {
    updateAppendSetting(false);
    expect(getSystemPromptConfig().appendDateTimeAndUserName).toBeFalse();
    updateAppendSetting(true);
    expect(getSystemPromptConfig().appendDateTimeAndUserName).toBeTrue();
  });

  test("内置提示词不可编辑或删除", () => {
    expect(() => updateSystemPrompt(BUILTIN_DEFAULT_ID, { name: "改名" })).toThrow("内置提示词不可编辑");
    expect(() => deleteSystemPrompt(BUILTIN_DEFAULT_ID)).toThrow("内置提示词不可删除");
  });

  test("配置损坏时应备份并回退默认配置", () => {
    const path = getSystemPromptsPath();
    writeFileSync(path, "{broken-json", "utf-8");
    const config = getSystemPromptConfig();
    expect(config.defaultPromptId).toBe(BUILTIN_DEFAULT_ID);
    const files = readdirSync(tempConfigDir);
    expect(files.some((name) => name.startsWith("system-prompts.json.corrupt-"))).toBeTrue();
  });
});
