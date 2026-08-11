// provider 推荐排序（参考 wanta connection-provider-ranking.ts）。
// 常用 service 优先，未列出的排其后；调用方负责叠加"已连接优先"等业务权重。

export const RECOMMENDED_LINK_SERVICES = [
  "gmail", "googlesheets", "googlecalendar", "googledrive", "github",
  "slack", "notion", "googledocs", "airtable", "trello", "jira", "linear",
  "asana", "clickup", "hubspot", "googleforms", "googleslides", "dropbox",
  "confluence", "outlook", "discord", "telegram", "stripe", "shopify",
  "googleanalytics", "googlesearchconsole", "openai", "anthropic", "gemini",
  "deepseek", "gitlab", "dockerhub", "vercel", "cloudflareworker", "awss3",
  "cloudflarer2", "googlebigquery",
] as const

const priorityMap = new Map(
  RECOMMENDED_LINK_SERVICES.map((service, index) => [compactService(service), index]),
)

/** service 在推荐表中的优先级（越小越靠前，表外返回 MAX）。 */
export function linkServicePriority(service: string): number {
  return priorityMap.get(compactService(service)) ?? Number.MAX_SAFE_INTEGER
}

/** 默认目录只展示 Wanta 推荐服务；已连接、选中和搜索命中的服务由目录层额外保留。 */
export function isRecommendedLinkService(service: string): boolean {
  return priorityMap.has(compactService(service))
}

export function shouldShowLinkProviderByDefault(service: string, configured: boolean, selected: boolean): boolean {
  return isRecommendedLinkService(service) || configured || selected
}

// 容错匹配：去标点连字符（如 "google-sheets" → "googlesheets"）再比对
function compactService(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "")
}
