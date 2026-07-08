// packages/shared/src/types/model-meta.ts

/**
 * model-meta 运行时数据源 IPC channel（sidecar RPC）。
 * 数据层 ModelMeta 接口在 data/model-meta.ts，本文件仅放 IPC 协议。
 */
export const MODEL_META_IPC_CHANNELS = {
  /** 读取 config dir 的 generated.json（未 merge）；ENOENT 返回 null，调用方保持 seed */
  GET: "model-meta:get",
} as const
