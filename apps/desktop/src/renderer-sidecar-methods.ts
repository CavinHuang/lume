// Explicit renderer -> sidecar RPC allowlist. Private/main-only channels must never appear here.
// shared *_IPC_CHANNELS 通道经 @lume/shared 派生（单源，契约测试守卫）；此处只保留本地增量。
import { SHARED_RENDERER_SIDECAR_METHODS } from "../../../packages/shared/src/types/renderer-allowlist";

/**
 * 派生集之外的本地增量：
 * - link:* —— Link 连接器通道未建 *_IPC_CHANNELS 常量；
 * - browser:* —— BROWSER_IPC_CHANNELS 走桌面专属入口，被派生规则排除的四个只读 method；
 * - agent:revert-coding-file / revert-coding-run / rewind-coding-turn —— 无 shared 常量；
 * - lume-config:changed —— CHANGED 通知 key 被派生规则排除，但 renderer 经 sidecar_call 订阅；
 * - healthcheck —— runtime IPC_CHANNELS 之外的裸方法。
 */
const LOCAL_RENDERER_SIDECAR_METHODS = [
  'link:providers-list',
  'link:providers-search',
  'link:provider-detail',
  'link:connections-list',
  'link:connection-upsert',
  'link:connection-delete',
  'link:oauth-configs',
  'link:oauth-sessions',
  'link:oauth-config-save',
  'link:oauth-start',
  'link:oauth-status',
  'link:oauth-cancel',
  'link:actions-list',
  'link:action-detail',
  'link:runs-list',
  'link:run-detail',
  'browser:backends',
  'browser:reference-candidates',
  'browser:create-reference-grant',
  'browser:revoke-reference-grant',
  'agent:revert-coding-file',
  'agent:revert-coding-run',
  'agent:rewind-coding-turn',
  'lume-config:changed',
  'healthcheck',
]

export const PUBLIC_RENDERER_SIDECAR_METHODS = new Set([
  ...SHARED_RENDERER_SIDECAR_METHODS,
  ...LOCAL_RENDERER_SIDECAR_METHODS,
])
