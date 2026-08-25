/**
 * Persona RPC handlers（sidecar）。
 *
 * 模式参考 suggestion-handlers / model-meta-handlers：
 * - 每个 channel 用 `validateInput` 校验入参，失败 throw（→ reject → toast）
 * - get 只读 global persona Markdown + 解析为结构化字段；null → 空响应
 * - correct 写底层记忆（显式纠正，不直接改派生文件）
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

/** persona 仅 global scope：GET/REGENERATE 均不接收 scope/workspaceSlug 参数 */
const emptyInputSchema = z.object({}).strict();

const correctionInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  correction: z.string().trim().min(1)
}).strict();

export function createPersonaHandlers(): Record<string, RpcHandler> {
  return {
    [PERSONA_IPC_CHANNELS.GET]: async (params) => {
      validateInput(emptyInputSchema, params, PERSONA_IPC_CHANNELS.GET);
      const markdown = readPersonaRaw();
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
      validateInput(emptyInputSchema, params, PERSONA_IPC_CHANNELS.REGENERATE);
      await ensurePersona({});
      return { ok: true as const };
    },
  };
}
