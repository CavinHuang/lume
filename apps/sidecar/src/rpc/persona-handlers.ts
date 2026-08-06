/**
 * Persona RPC handlers（sidecar）。
 *
 * 模式参考 suggestion-handlers / model-meta-handlers：
 * - 每个 channel 用 `validateInput` 校验入参，失败 throw（→ reject → toast）
 * - get 只读 global persona Markdown + 解析为结构化字段；null → 空响应
 * - update 拒绝直接改派生文件；correct 写底层记忆
 * - regenerate 强制触发 ensurePersona（忽略节流，fail-open）
 *
 * ensurePersona 自身 fail-open（不抛错），但 handlers 仍保持「入参非法即 throw」
 * 的 IPC 契约，调用方依赖此约定显示错误提示。
 */

import { existsSync, statSync } from "node:fs";
import { PERSONA_IPC_CHANNELS, type PersonaGetResult } from "@lume/shared";
import {
  ensurePersona,
  getPersonaPath,
  parsePersonaProfile,
  readPersonaRaw,
} from "../services/memory-v2/persona";
import type { RpcHandler } from "./types";
import { validateInput, z } from "./validation";

const SCOPE_VALUES = ["global", "workspace"] as const;

const getInputSchema = z
  .object({
    scope: z.enum(SCOPE_VALUES).optional(),
    workspaceSlug: z.string().trim().min(1).optional(),
  })
  .strict();

const updateInputSchema = z
  .object({
    scope: z.enum(SCOPE_VALUES).optional(),
    workspaceSlug: z.string().trim().min(1).optional(),
    markdown: z.string().min(1),
  })
  .strict();

const regenerateInputSchema = z
  .object({
    scope: z.enum(SCOPE_VALUES).optional(),
    workspaceSlug: z.string().trim().min(1).optional(),
  })
  .strict();

const correctionInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  correction: z.string().trim().min(1)
}).strict();

export function createPersonaHandlers(): Record<string, RpcHandler> {
  return {
    [PERSONA_IPC_CHANNELS.GET]: async (params) => {
      validateInput(getInputSchema, params, PERSONA_IPC_CHANNELS.GET);
      const markdown = readPersonaRaw("global");
      if (markdown === null) {
        return {
          markdown: "",
          parsed: parsePersonaProfile(""),
        } satisfies PersonaGetResult;
      }
      const path = getPersonaPath("global");
      const updatedAt = existsSync(path) ? statSync(path).mtime.toISOString() : undefined;
      return {
        markdown,
        parsed: parsePersonaProfile(markdown),
        updatedAt,
      } satisfies PersonaGetResult;
    },
    [PERSONA_IPC_CHANNELS.UPDATE]: async (params) => {
      validateInput(updateInputSchema, params, PERSONA_IPC_CHANNELS.UPDATE);
      throw new Error("Persona 是派生视图，请使用 persona:correct 修正底层记忆");
    },
    [PERSONA_IPC_CHANNELS.CORRECT]: async (params) => {
      const input = validateInput(correctionInputSchema, params, PERSONA_IPC_CHANNELS.CORRECT);
      const { MemoryCommandService } = await import("../services/memory-v2/command-service");
      return new MemoryCommandService().remember({
        workspaceSlug: input.workspaceSlug,
        content: input.correction,
        scope: "global",
        semanticRole: "preference",
        facets: ["correction", "persona-correction"],
        confidence: "high",
        actor: "user",
        explicitCorrection: true
      });
    },
    [PERSONA_IPC_CHANNELS.REGENERATE]: async (params) => {
      const input = validateInput(regenerateInputSchema, params, PERSONA_IPC_CHANNELS.REGENERATE);
      await ensurePersona({
        scope: "global"
      });
      return { ok: true as const };
    },
  };
}
