/**
 * IAB 后端描述符 —— ZCode plugin-facade 消费形状的单源工厂。
 *
 * 来源:
 *   - .zcode/analysis/extracted/09-plugin-facade.source.mjs:capabilityIds 按
 *     capability.id 建集、apiSupportOverrides[key] 短路查询、documentation 引用
 *     descriptor.name/type/id;
 *   - ./capabilities.ts:BROWSER_CAPABILITIES 描述符表与 apiSupport 矩阵
 *     (capabilities.browser 元素 id = capability.name,overrides 恒 true)。
 *
 * 唯一消费入口 buildIabDescriptor:desktop(assemble.ts descriptor(),sidecar 桥
 * 能力协商)与 sidecar(iab-backend.ts 模型侧后端描述符)共用,两端不再各造
 * 形状;sidecar 的自有附加字段(metadata 等)在工厂产物上扩展,不改动共享形状。
 */
import { BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND, BROWSER_CAPABILITIES } from "./capabilities"

/** ZCode plugin-facade 消费形状的 capability 元素(capabilityIds 按 id 建集)。 */
export interface BrowserDescriptorCapability {
  id: string
  title: string
  description: string
}

/** ZCode 后端描述符(plugin-facade 消费形状;generation 刻意不对模型暴露)。 */
export interface BrowserBackendDescriptor {
  id: string
  generation: number
  type: "iab"
  name: string
  capabilities: {
    browser: BrowserDescriptorCapability[]
    tab: string[]
  }
  apiSupportOverrides: Record<string, boolean>
}

export interface BuildIabDescriptorOptions {
  /** 后端实例标识(ZCode 形态 "iab:<uuid>",由调用方生成)。 */
  id: string
  /** 后端代数(调用方创建时刻;归属上下文 browserGeneration 与之同源)。 */
  generation: number
  /** 后端显示名(documentation "- Name:" 行);缺省 "Lume In-app Browser"。 */
  name?: string
}

/** ZCode 形状的 IAB 描述符(capabilities/overrides 由 shared 矩阵单源映射)。 */
export function buildIabDescriptor(options: BuildIabDescriptorOptions): BrowserBackendDescriptor {
  return {
    id: options.id,
    generation: options.generation,
    type: "iab",
    name: options.name ?? "Lume In-app Browser",
    capabilities: {
      browser: BROWSER_CAPABILITIES.map((capability) => ({
        id: capability.name,
        title: capability.title,
        description: capability.description,
      })),
      tab: [],
    },
    apiSupportOverrides: Object.fromEntries(
      BROWSER_API_SUPPORT_OVERRIDES_BY_BACKEND.iab.map((api) => [api, true]),
    ),
  }
}
