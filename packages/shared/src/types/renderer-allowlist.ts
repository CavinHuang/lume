/**
 * Renderer 可调用 sidecar method 的 shared 单源派生清单（事件总线批次5 Task 7b）。
 *
 * 派生规则与契约测试 apps/desktop/scripts/electron-security.test.mjs 的
 * "renderer sidecar allowlist tracks public shared IPC channels" 逐字一致：
 * - 取全部 *_IPC_CHANNELS 常量（PLUGIN_PACKAGE_PRIVILEGED 与 AGENT_ISLAND 除外——
 *   前者主进程专属，后者 island 窗口专用通道）；
 * - 排除通知类 key（CHANGED/REMINDER_DUE/EVENTS，renderer 经事件通道订阅而非 RPC 调用）；
 * - 排除 privileged 通道与 BROWSER_IPC_CHANNELS 成员（走桌面专属入口）。
 * 新增通道常量时需同步本文件的 source 列表；契约测试是漏配的绊线（会红）。
 */
import { AGENT_IPC_CHANNELS } from "./agent"
import { AUTOMATION_IPC_CHANNELS } from "./automation"
import { BROWSER_IPC_CHANNELS } from "./browser-runtime"
import { CHANNEL_IPC_CHANNELS } from "./channel"
import { DESKTOP_CONTEXT_IPC_CHANNELS } from "./computer-use"
import { GENERAL_SETTINGS_IPC_CHANNELS } from "./general-settings"
import { GITHUB_RELEASE_IPC_CHANNELS } from "./github-release"
import { IM_IPC_CHANNELS } from "./im"
import { LUME_CONFIG_IPC_CHANNELS } from "./lume-config"
import { MEMORY_IPC_CHANNELS } from "./memory"
import { MODEL_META_IPC_CHANNELS } from "./model-meta"
import { PERSONA_IPC_CHANNELS } from "./persona"
import { PLANNING_TODO_IPC_CHANNELS } from "./planning-todo"
import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "./reading"
import { ROUTINE_IPC_CHANNELS } from "./routine"
import { IPC_CHANNELS as RUNTIME_IPC_CHANNELS } from "./runtime"
import { SUGGESTION_IPC_CHANNELS } from "./suggestion"
import { SYSTEM_CONFIG_IPC_CHANNELS } from "./system-config"
import { UI_STATE_IPC_CHANNELS } from "./ui-state"
import { WIKI_IPC_CHANNELS } from "./wiki"

/** 通知类 key：不可作为 renderer RPC method 暴露 */
const NOTIFICATION_CHANNEL_KEYS = new Set(["CHANGED", "REMINDER_DUE", "EVENTS"])

const BROWSER_CHANNEL_VALUES = new Set<string>(Object.values(BROWSER_IPC_CHANNELS))

const PUBLIC_CHANNEL_SOURCES = [
  AGENT_IPC_CHANNELS,
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
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
  RUNTIME_IPC_CHANNELS,
  SUGGESTION_IPC_CHANNELS,
  SYSTEM_CONFIG_IPC_CHANNELS,
  UI_STATE_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS,
  WIKI_IPC_CHANNELS,
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
        !BROWSER_CHANNEL_VALUES.has(value),
    )
    .map(([, value]) => value),
)
