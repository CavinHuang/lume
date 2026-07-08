import { sidecarCall } from './system'
import { MODEL_META_IPC_CHANNELS, type ModelMeta } from '@lume/shared'

/**
 * 拉取 config dir 的 generated.json（未 merge 的原始 generated）。
 * 返回 null 表示 config dir 无文件（首次启动），调用方应保持 seed。
 */
export const getModelMeta = () =>
  sidecarCall<ModelMeta[] | null>(MODEL_META_IPC_CHANNELS.GET, {})
