/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\system-prompt-manager.ts
 * Adaptation:
 * - Switched storage path from ~/.proma to ~/.lume.
 * - Added config version field and atomic write for MVP durability.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
  type SystemPrompt,
  type SystemPromptConfig,
  type SystemPromptCreateInput,
  type SystemPromptUpdateInput
} from "@lume/shared";
import { getSystemPromptsPath } from "../config-paths";

const SYSTEM_PROMPT_CONFIG_VERSION = 1;

function getDefaultConfig(): SystemPromptConfig {
  return {
    version: SYSTEM_PROMPT_CONFIG_VERSION,
    prompts: [{ ...BUILTIN_DEFAULT_PROMPT }],
    defaultPromptId: BUILTIN_DEFAULT_ID,
    appendDateTimeAndUserName: true
  };
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptFile(filePath: string, label: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    console.warn(`[${label}] 检测到损坏配置，已备份: ${backupPath}`);
  } catch (error) {
    console.warn(`[${label}] 备份损坏配置失败:`, error);
  }
}

function normalizePrompt(raw: unknown): SystemPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!id || !name) return null;

  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;
  return {
    id,
    name,
    content,
    isBuiltin: record.isBuiltin === true,
    createdAt,
    updatedAt
  };
}

function normalizeConfig(raw: unknown): SystemPromptConfig {
  const defaults = getDefaultConfig();
  if (!raw || typeof raw !== "object") return defaults;

  const record = raw as Record<string, unknown>;
  const normalizedPrompts: SystemPrompt[] = [];
  const rawPrompts = Array.isArray(record.prompts) ? record.prompts : [];
  for (const item of rawPrompts) {
    const normalized = normalizePrompt(item);
    if (normalized) normalizedPrompts.push(normalized);
  }

  const builtinIndex = normalizedPrompts.findIndex((item) => item.id === BUILTIN_DEFAULT_ID);
  if (builtinIndex === -1) {
    normalizedPrompts.unshift({ ...BUILTIN_DEFAULT_PROMPT });
  } else {
    normalizedPrompts[builtinIndex] = { ...BUILTIN_DEFAULT_PROMPT };
  }

  const appendDateTimeAndUserName = typeof record.appendDateTimeAndUserName === "boolean"
    ? record.appendDateTimeAndUserName
    : true;

  const rawDefaultPromptId = typeof record.defaultPromptId === "string"
    ? record.defaultPromptId
    : BUILTIN_DEFAULT_ID;
  const defaultPromptId = normalizedPrompts.some((item) => item.id === rawDefaultPromptId)
    ? rawDefaultPromptId
    : BUILTIN_DEFAULT_ID;

  return {
    version: SYSTEM_PROMPT_CONFIG_VERSION,
    prompts: normalizedPrompts,
    defaultPromptId,
    appendDateTimeAndUserName
  };
}

function readConfig(): SystemPromptConfig {
  const filePath = getSystemPromptsPath();
  if (!existsSync(filePath)) {
    return getDefaultConfig();
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    console.error("[系统提示词] 读取配置失败:", error);
    backupCorruptFile(filePath, "系统提示词");
    return getDefaultConfig();
  }
}

function writeConfig(config: SystemPromptConfig): void {
  const filePath = getSystemPromptsPath();
  writeTextAtomic(filePath, JSON.stringify(config, null, 2));
}

export function getSystemPromptConfig(): SystemPromptConfig {
  const config = readConfig();
  writeConfig(config);
  return config;
}

export function createSystemPrompt(input: SystemPromptCreateInput): SystemPrompt {
  const name = input.name.trim();
  if (!name) throw new Error("提示词名称不能为空");

  const config = readConfig();
  const now = Date.now();
  const prompt: SystemPrompt = {
    id: randomUUID(),
    name,
    content: input.content,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now
  };

  config.prompts.push(prompt);
  writeConfig(config);
  console.log(`[系统提示词] 已创建: ${prompt.name} (${prompt.id})`);
  return prompt;
}

export function updateSystemPrompt(id: string, input: SystemPromptUpdateInput): SystemPrompt {
  const config = readConfig();
  const index = config.prompts.findIndex((item) => item.id === id);
  if (index === -1) throw new Error(`提示词不存在: ${id}`);

  const existing = config.prompts[index];
  if (!existing) throw new Error(`提示词不存在: ${id}`);
  if (existing.isBuiltin) throw new Error("内置提示词不可编辑");

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) throw new Error("提示词名称不能为空");
  const nextContent = input.content !== undefined ? input.content : existing.content;

  const updated: SystemPrompt = {
    ...existing,
    name: nextName,
    content: nextContent,
    updatedAt: Date.now()
  };

  config.prompts[index] = updated;
  writeConfig(config);
  console.log(`[系统提示词] 已更新: ${updated.name} (${updated.id})`);
  return updated;
}

export function deleteSystemPrompt(id: string): void {
  const config = readConfig();
  const target = config.prompts.find((item) => item.id === id);
  if (!target) throw new Error(`提示词不存在: ${id}`);
  if (target.isBuiltin) throw new Error("内置提示词不可删除");

  config.prompts = config.prompts.filter((item) => item.id !== id);
  if (config.defaultPromptId === id) {
    config.defaultPromptId = BUILTIN_DEFAULT_ID;
  }
  writeConfig(config);
  console.log(`[系统提示词] 已删除: ${target.name} (${id})`);
}

export function updateAppendSetting(enabled: boolean): void {
  const config = readConfig();
  config.appendDateTimeAndUserName = enabled;
  writeConfig(config);
  console.log(`[系统提示词] 追加设置已更新: ${enabled}`);
}

export function setDefaultPrompt(id: string | null): void {
  const config = readConfig();
  if (id !== null) {
    const exists = config.prompts.some((item) => item.id === id);
    if (!exists) throw new Error(`提示词不存在: ${id}`);
  }
  config.defaultPromptId = id ?? BUILTIN_DEFAULT_ID;
  writeConfig(config);
  console.log(`[系统提示词] 默认提示词已设置: ${config.defaultPromptId}`);
}
