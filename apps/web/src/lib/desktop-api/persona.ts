import { invoke } from '@/lib/desktop-runtime/core'
import {
  PERSONA_IPC_CHANNELS,
  type PersonaCorrectionInput,
  type PersonaGetResult,
} from '@lume/shared'

const call = <T>(method: string, params: unknown) =>
  invoke<T>('sidecar_call', { method, params })

/** 读取当前 persona markdown（含解析后的结构化字段） */
export const getPersona = (workspaceSlug?: string) =>
  call<PersonaGetResult>(
    PERSONA_IPC_CHANNELS.GET,
    workspaceSlug ? { workspaceSlug } : {},
  )

export const correctPersona = (input: PersonaCorrectionInput) =>
  call(PERSONA_IPC_CHANNELS.CORRECT, input)

/** 触发 LLM 基于 memory 重新生成 persona */
export const regeneratePersona = (workspaceSlug?: string) =>
  call<{ ok: true }>(
    PERSONA_IPC_CHANNELS.REGENERATE,
    workspaceSlug ? { workspaceSlug } : {},
  )
