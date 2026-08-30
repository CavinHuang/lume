/**
 * 浏览器能力协商 —— capability 描述符 + apiSupport 矩阵。
 *
 * 来源(ZCode BrowserApiPolicy 模型,guide §4.4 / architecture §能力协商):
 *   - 成员按 `(object, member)` 声明 `unsupportedByDefaultIn`(默认禁用的后端)与
 *     `requiresCapabilities`;后端描述符携带 `apiSupportOverrides` 短路翻转;
 *   - IAB 后端用 override 强制打开 `claimTab / finalize / markDeliverable /
 *     markHandoff / recording.*`;
 *   - 唯一 capability 描述符是 `visibility`(面向模型的使用说明:"后台工作,除非用户要看");
 *   - "隐藏而非报错":门面据此把不支持成员从 API 文档过滤(effectiveApi)。
 *
 * 注:本文件只承载协议侧矩阵与解析;门面 Proxy 隐藏机制在插件层实现。
 */

/** 浏览器后端类型(ZCode 现有:iab 内嵌 / cdp 外接) */
export type BrowserBackendType = "iab" | "cdp"

/**
 * capability 描述符。
 * `description` 为面向模型的使用说明(documentation() 动态生成时直接引用)。
 */
export interface BrowserCapabilityDescriptor {
  name: string
  title: string
  description: string
}

/**
 * `visibility` —— 唯一 capability 描述符。
 * 使用说明按 ZCode 语义转写:"后台工作,除非用户要看"(agent 默认不显示浏览器面板)。
 */
export const BROWSER_CAPABILITY_VISIBILITY: BrowserCapabilityDescriptor = {
  name: "visibility",
  title: "visibility",
  description:
    "浏览器默认后台工作(run in background)。除非当前任务明确需要用户看到页面,不要主动显示浏览器面板或抢占用户焦点。",
}

/** 全量 capability 描述符表(当前仅 visibility) */
export const BROWSER_CAPABILITIES: readonly BrowserCapabilityDescriptor[] = [BROWSER_CAPABILITY_VISIBILITY]

/**
 * apiSupport 矩阵条目。
 * `api` 为门面 API 路径(点分);尾段 `.*` 为通配(如 `tab.recording.*`)。
 */
export interface BrowserApiSupportEntry {
  api: string
  /** 这些后端默认禁用该成员(其余后端默认可用) */
  unsupportedByDefaultIn: readonly BrowserBackendType[]
  /** 可用所需 capability(缺省无要求) */
  requiresCapabilities?: readonly string[]
}

/**
 * 默认禁用矩阵。
 * - 归属五类(claimTab/finalize/markDeliverable/markHandoff/recording.*):iab/cdp 默认禁用,
 *   由各后端 override 决定是否打开(ZCode IAB override 强制开);
 * - 文件上传(fileChooserSetFiles / filechooser 事件等待):iab 显式不支持
 *   (管理器返回 capability_unsupported "File uploads are not supported by iab")。
 */
export const BROWSER_API_SUPPORT_MATRIX: readonly BrowserApiSupportEntry[] = [
  { api: "browser.user.claimTab", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.finalize", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.markDeliverable", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.markHandoff", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.recording.*", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.playwright.fileChooserSetFiles", unsupportedByDefaultIn: ["iab", "cdp"] },
  { api: "tab.playwright.waitForFileChooser", unsupportedByDefaultIn: ["iab", "cdp"] },
]

/** 各后端的 apiSupportOverrides(短路翻转为可用) */
export const BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND: Readonly<
  Record<BrowserBackendType, readonly string[]>
> = {
  iab: [
    "browser.user.claimTab",
    "tab.finalize",
    "tab.markDeliverable",
    "tab.markHandoff",
    "tab.recording.*",
  ],
  cdp: [],
}

/** API 路径匹配:全等或尾段通配(`tab.recording.*` 命中 `tab.recording.start`) */
function matchesApiPattern(pattern: string, api: string): boolean {
  return pattern === api || (pattern.endsWith(".*") && api.startsWith(pattern.slice(0, -1)))
}

/**
 * 解析某后端下 API 成员是否可用(effectiveApi 过滤依据)。
 * 未在矩阵中声明的成员默认全后端可用;override 命中即短路为可用。
 */
export function resolveBrowserApiSupport(api: string, backend: BrowserBackendType): boolean {
  const overrides = BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND[backend]
  if (overrides.some((pattern) => matchesApiPattern(pattern, api))) return true
  const entry = BROWSER_API_SUPPORT_MATRIX.find((candidate) => matchesApiPattern(candidate.api, api))
  if (!entry) return true
  return !entry.unsupportedByDefaultIn.includes(backend)
}

/** capability 满足校验(requiresCapabilities 非空时逐一对描述符表核对) */
export function hasBrowserCapabilities(required: readonly string[] | undefined, granted: readonly string[]): boolean {
  if (!required || required.length === 0) return true
  return required.every((name) => granted.includes(name))
}
