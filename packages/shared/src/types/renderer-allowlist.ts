/**
 * Renderer 可调用 sidecar method 的 shared 单源派生清单（事件总线批次5 Task 7b）。
 *
 * 派生规则与契约测试 apps/desktop/scripts/electron-security.test.mjs 的
 * "renderer sidecar allowlist tracks public shared IPC channels" 逐字一致：
 * - 取全部 *_IPC_CHANNELS 常量（PLUGIN_PACKAGE_PRIVILEGED 与 AGENT_ISLAND 除外——
 *   前者主进程专属，后者 island 窗口专用通道）；
 * - 排除通知类 key（CHANGED/REMINDER_DUE/EVENTS，renderer 经事件通道订阅而非 RPC 调用）；
 * - 排除 privileged 通道与 BROWSER_IPC_CHANNELS 成员（走桌面专属入口）。
 * （#528 清理：RENDERER_BLOCKED_CHANNEL_VALUES 黑名单已随 copy-folder 两条死通道一并删除。）
 * 新增通道常量时需同步本文件的 source 列表；契约测试是漏配的绊线（会红）。
 */
import { AGENT_IPC_CHANNELS } from "./agent"
import { AUTOMATION_IPC_CHANNELS } from "./automation"
import { BROWSER_IPC_CHANNELS } from "./browser-runtime"
import { CHANNEL_IPC_CHANNELS } from "./channel"
import { DESKTOP_CONTEXT_IPC_CHANNELS } from "./computer-use"
import { GENERAL_SETTINGS_IPC_CHANNELS } from "./general-settings"
import { GITHUB_RELEASE_IPC_CHANNELS } from "./github-release"
import { CONNECTOR_IPC_CHANNELS } from "./connector"
import { IM_IPC_CHANNELS } from "./im"
import { LUME_CONFIG_IPC_CHANNELS } from "./lume-config"
import { MEMORY_IPC_CHANNELS } from "./memory"
import { MODEL_META_IPC_CHANNELS } from "./model-meta"
import { PERSONA_IPC_CHANNELS } from "./persona"
import { PLANNING_TODO_IPC_CHANNELS } from "./planning-todo"
import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "./reading"
import { ROUTINE_IPC_CHANNELS } from "./routine"
import { SUGGESTION_IPC_CHANNELS } from "./suggestion"

/** 通知类 key：不可作为 renderer RPC method 暴露 */
const NOTIFICATION_CHANNEL_KEYS = new Set(["CHANGED", "REMINDER_DUE", "EVENTS"])

/**
 * 通知型通道值(#531 复审分离)：sidecar 经 writeNotification 单向推送
 * (apps/sidecar/src/index.ts:73)，不经过渲染端→sidecar 的 sidecar_call 准入，
 * 因此不得进入可调用 method 派生集。逐值显式列举(命名无稳定后缀，
 * 后缀规则会误伤)；新增推送通道时在此登记。REVIEW 口径见契约测试。
 */
export const NOTIFY_ONLY_CHANNEL_VALUES: ReadonlySet<string> = new Set([
  "agent:ask-user-question",
  "agent:capabilities-changed",
  "agent:desktop-action-request",
  "agent:message-queue-changed",
  "agent:plan-mode-phase-changed",
  "agent:skill-improvement-suggested",
  "agent:subagent-completed",
  "agent:tool-permission-request",
  "agent:workspace-files-changed",
  "desktop-context:proposal-updated",
  "memory:source-files-changed",
  "reading:noteGenDone",
  "reading:noteGenFailed",
])

const BROWSER_CHANNEL_VALUES = new Set<string>(Object.values(BROWSER_IPC_CHANNELS))

const PUBLIC_CHANNEL_SOURCES = [
  AGENT_IPC_CHANNELS,
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  CONNECTOR_IPC_CHANNELS,
  DESKTOP_CONTEXT_IPC_CHANNELS,
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  IM_IPC_CHANNELS,
  LUME_CONFIG_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  MODEL_META_IPC_CHANNELS,
  PERSONA_IPC_CHANNELS,
  PLANNING_TODO_IPC_CHANNELS,
  READING_IPC_CHANNELS,
  ROUTINE_IPC_CHANNELS,
  SUGGESTION_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS,
]

/** shared 通道派生的 renderer 可调用 method 集；desktop 在此之上加本地增量 */
export const SHARED_RENDERER_SIDECAR_METHODS: ReadonlySet<string> = new Set(
  PUBLIC_CHANNEL_SOURCES
    .flatMap((channels) => Object.entries(channels))
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        !NOTIFICATION_CHANNEL_KEYS.has(key) &&
        !value.includes(":privileged-") &&
        !BROWSER_CHANNEL_VALUES.has(value) &&
        !NOTIFY_ONLY_CHANNEL_VALUES.has(value),
    )
    .map(([, value]) => value),
)

/**
 * 派生集之外的本地增量（desktop 侧全量消费，契约测试双向 == 断言）：
 * - browser:* —— BROWSER_IPC_CHANNELS 走桌面专属入口，被派生规则排除的四个只读 method；
 * - lume-config:changed —— CHANGED 通知 key 被派生规则排除，但 renderer 经 sidecar_call 订阅；
 * - healthcheck —— runtime IPC_CHANNELS 之外的裸方法。
 * （F5 清理曾删除 agent:revert-coding-file / revert-coding-run / rewind-coding-turn
 * 死条目；其后快照还原功能(#572)为前两者接入了真实 handler，经 sidecar_call 正常放行。）
 */
export const LOCAL_RENDERER_SIDECAR_METHODS: readonly string[] = [
  "browser:backends",
  "browser:reference-candidates",
  "browser:create-reference-grant",
  "browser:revoke-reference-grant",
  "lume-config:changed",
  "healthcheck",
]
