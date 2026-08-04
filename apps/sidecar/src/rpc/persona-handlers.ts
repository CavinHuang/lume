/**
 * Persona RPC handlers（sidecar）。
 *
 * 模式参考 suggestion-handlers / model-meta-handlers：
 * - 每个 channel 用 `validateInput` 校验入参，失败 throw（→ reject → toast）
 * - get 直读 persona Markdown + 解析为结构化字段；null → 空响应
 * - update 直写 persona Markdown（非空校验）
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
  writePersona,
} from "../services/memory-v2/persona";
import type { MemoryV2Scope } from "../services/memory-v2/types";
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

/**
 * 解析 scope/workspaceSlug：与 ensurePersona 同一约定。
 * - scope 缺省：workspaceSlug 存在 → "workspace"，否则 "global"
 * - workspaceSlug 仅在 scope === "workspace" 时保留
 */
function resolveScope(
  input: { scope?: MemoryV2Scope; workspaceSlug?: string },
): { scope: MemoryV2Scope; workspaceSlug: string | undefined } {
  const scope: MemoryV2Scope = input.scope ?? (input.workspaceSlug ? "workspace" : "global");
  const workspaceSlug = scope === "workspace" ? input.workspaceSlug : undefined;
  return { scope, workspaceSlug };
}

export function createPersonaHandlers(): Record<string, RpcHandler> {
  return {
    [PERSONA_IPC_CHANNELS.GET]: async (params) => {
      const input = validateInput(getInputSchema, params, PERSONA_IPC_CHANNELS.GET);
      const { scope, workspaceSlug } = resolveScope(input);
      const markdown = readPersonaRaw(scope, workspaceSlug);
      if (markdown === null) {
        return {
          markdown: "",
          parsed: parsePersonaProfile(""),
        } satisfies PersonaGetResult;
      }
      const path = getPersonaPath(scope, workspaceSlug);
      const updatedAt = existsSync(path) ? statSync(path).mtime.toISOString() : undefined;
      return {
        markdown,
        parsed: parsePersonaProfile(markdown),
        updatedAt,
      } satisfies PersonaGetResult;
    },
    [PERSONA_IPC_CHANNELS.UPDATE]: async (params) => {
      const input = validateInput(updateInputSchema, params, PERSONA_IPC_CHANNELS.UPDATE);
      const { scope, workspaceSlug } = resolveScope(input);
      writePersona(scope, workspaceSlug, input.markdown);
      return { ok: true as const };
    },
    [PERSONA_IPC_CHANNELS.REGENERATE]: async (params) => {
      const input = validateInput(regenerateInputSchema, params, PERSONA_IPC_CHANNELS.REGENERATE);
      await ensurePersona({
        scope: input.scope,
        workspaceSlug: input.workspaceSlug,
      });
      return { ok: true as const };
    },
  };
}
