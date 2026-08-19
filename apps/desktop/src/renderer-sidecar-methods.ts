// Explicit renderer -> sidecar RPC allowlist. Private/main-only channels must never appear here.
// shared *_IPC_CHANNELS 通道经 @lume/shared 派生（单源，契约测试守卫）；本地增量同样
// 由 shared 导出（renderer-allowlist.ts 的 LOCAL_RENDERER_SIDECAR_METHODS），契约测试
// 双向 == 断言（派生+本地 与 桌面侧 Set 完全相等）。
import {
  LOCAL_RENDERER_SIDECAR_METHODS,
  SHARED_RENDERER_SIDECAR_METHODS,
} from "../../../packages/shared/src/types/renderer-allowlist";

export const PUBLIC_RENDERER_SIDECAR_METHODS = new Set([
  ...SHARED_RENDERER_SIDECAR_METHODS,
  ...LOCAL_RENDERER_SIDECAR_METHODS,
])
