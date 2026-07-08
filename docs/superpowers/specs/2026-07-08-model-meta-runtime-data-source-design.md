# model-meta 运行时数据源改造（子项目 A）

- **日期**: 2026-07-08
- **状态**: 待实现（设计已批准）
- **关联**: `2026-07-07-models-dev-sync-design.md`（前置——构建期同步特性，本设计在其上改运行时）、memory `lume-model-meta-runtime-data-source` / `lume-models-dev-sync-feature`

## 1. 背景与现状

models.dev 构建期同步特性（2026-07-07）已落地：`scripts/sync-models.ts` 从 models.dev 拉取生成 `model-meta.generated.json`，`model-meta.ts` 静态 import 后 `mergeModelMeta(generated, MODEL_OVERRIDES)` 构造 registry。

**根因（build-time bundled）**：`model-meta.ts:5` `import generatedJson from './model-meta.generated.json'`，Vite/Bun 把 JSON 编译成内联对象字面量进 bundle。运行时不存在「文件」——renderer 读的是编译期固化进 chunk 的数据。所以运行时改 generated.json 对已加载的 web 进程不可见。模块级 `const MODEL_META_REGISTRY`（:43）+ `const lookupMap`（:61）在 import 时立即求值并冻结。

**目标场景**：让「设置 → 数据管理 → 更新模型数据」按钮（子项目 B）真正运行时生效——用户点按钮后 web 能热更新模型元数据，无需重启 app、无需等版本发布。

**消费现状**（已核实）：`findModelMeta` 在 web 端 6 处消费——`AgentInput.tsx:535`、`ModelPicker.tsx:134,156`、`AgentSettings.tsx:1472`、`DefaultModelStrategyPanel.tsx:373`、`SubagentDefaultModelPanel.tsx:91`、`WelcomeModelPicker.tsx:99,144,167`，全为 `useMemo` 或 render 内调用。sidecar **不消费** model-meta（走 `ChannelModel.contextWindow`，见 models-dev-sync memory）。

## 2. 目标 / 非目标

**目标**

- 把 model-meta 改造为运行时数据源：registry 可在进程内替换（`setModelMeta`），`findModelMeta` 同步签名零变更。
- web 启动期从 sidecar 拉取 config dir 的 generated.json，覆盖 seed；之后 `findModelMeta` 同步读。
- reload 后 6 处消费者自动重算（version Context）。
- 现有 build-time bundled 数据降级为 seed fallback，不浪费、保证失败兜底。

**非目标（YAGNI）**

- 不建跨进程 push 事件通道（pull 足够，唯一改写入口是 web 发起的按钮）。
- 不给 sidecar 建 registry（sidecar 不消费 model-meta，无状态数据提供者）。
- 不改 `findModelMeta` / `inferCapabilities` / format\* 签名与行为。
- 不做子项目 B（按钮 + sync handler）——本 spec 仅 A（前提层）。
- 不改 `ModelMeta` 字段结构。

## 3. 已定决策

1. **数据通道：sidecar IPC 单一数据源**（方案 A）。generated.json 运行时由 sidecar 读写，web 经 `sidecarCall` 拉取。理由：sidecar 既是写者又是读者代理，单一数据源避免双份同步；IPC 链路（`sidecarCall`→`lume:invoke`→`sidecarHost.call`）全现成；不碰 `lume-file://` 安全白名单；不写 app 安装目录（规避 macOS `.app` bundle 写入权限风险）。
2. **加载语义**：`findModelMeta` 同步签名 + `setModelMeta(generated)` 替换 registry + 启动期加载 + version Context 感知 reload。
3. **bootstrap：seed 优先**（偏离 memory 原案「启动屏障 + loading」）。registry 初始化 = bundle seed（同步立即可用），sidecar 异步返回 config dir 数据后静默覆盖。无 loading 闪烁；代价是 config dir 与 seed 有差异时 UI 先显 seed 再跳新值（model 元数据差异极小，可接受）。
4. **sidecar 无状态化**（偏离 memory「sidecar reload」措辞）。sidecar 不持有 registry，只读写 config dir 文件。registry + seed + reload 全在 web 侧。
5. **pull 模式**（偏离 memory「reload 事件」措辞）。不建 push 事件；sync/get 响应直接带 generated，web 主动 `setModelMeta`。
6. **merge 单一在 web 侧**：sidecar 永远返回未 merge 的原始 generated，`mergeModelMeta(generated, MODEL_OVERRIDES)` 只在 web `setModelMeta` 内做一次。

> 偏离 memory 的 3 点（bootstrap seed 优先、sidecar 无状态、pull 模式）均为本次 design 细化后的修正，已用户确认。memory 原文为上一会话设想，以本 spec 为准。

## 4. 架构与数据流

### 4.1 运行时数据位置：config dir + bundle seed 双层

| 层 | 位置 | 角色 |
|---|---|---|
| 读写层 | `~/.lume/model-meta.generated.json`（`getConfigDir()`） | 运行时可读写，sidecar fetch+build 后写这里（B），GET 读这里（A） |
| seed 层 | `model-meta.ts` 模块加载时 `setModelMeta(generatedJson)` | build-time bundled，降级为 fallback / 初始值，所有 import shared 的进程自动获得 |

### 4.2 三条数据流（pull 模式）

```
① 启动加载（seed 优先）
   model-meta.ts 模块加载 ──> setModelMeta(seed)        // 同步，立即可用
   ModelMetaProvider mount ──> sidecarCall('model-meta:get')
                            ──> sidecar: read config dir (ENOENT→null)
                            <── generated | null
                            ── 若 generated: setModelMeta(generated) + bump version
                            ── 若 null: 保持 seed

② 同步更新（子项目 B，A 提供基础）
   web ──> sidecarCall('model-meta:sync')
        ──> sidecar: fetch models.dev + buildGenerated + write config dir
        <── newGenerated ── setModelMeta(new) + bump version

③ 运行时查询
   findModelMeta(id) ── 同步读 registry（6 处消费者零签名改动）
```

### 4.3 reload 感知：version Context

`ModelMetaContext` 存 `version: number`。`setModelMeta` 后 bump。6 处消费者 `useMemo` 依赖数组加 `useModelMetaVersion()`，version 变更触发重算 → 重新调 `findModelMeta` 拿新数据。

## 5. 组件改动清单

### packages/shared

| 文件 | 改动 |
|---|---|
| `src/data/model-meta.ts` | `MODEL_META_REGISTRY`/`lookupMap`：`const`→`let`；新增 `setModelMeta(generated: ModelMeta[])`（`mergeModelMeta(generated, MODEL_OVERRIDES)` → 替换 registry + 重建 lookupMap）；模块加载时 `setModelMeta(generatedJson)` 保向后兼容；`findModelMeta`/`inferCapabilities`/format\* 零变更 |
| `src/data/catalog-mapping.ts`（新） | 从 `scripts/sync-models.ts` 提取：`WHITELIST_PROVIDERS`、Catalog 类型、`buildGeneratedFromCatalog` 纯函数、`mapModel`（内部） |
| `src/data/index.ts` | re-export `buildGeneratedFromCatalog` |
| `scripts/sync-models.ts` | 改为从 `../src/data/catalog-mapping` import（去重），保留 `fetchCatalog`+`main`+write |
| `src/types/` | 新增 `MODEL_META_IPC_CHANNELS = { GET: 'model-meta:get' }`，从 `@lume/shared` 导出（`SYNC` 归 B） |

### apps/sidecar

| 文件 | 改动 |
|---|---|
| `src/rpc/model-meta-handlers.ts`（新） | `createModelMetaHandlers()`：`GET` 读 config dir generated.json，ENOENT→`null`，损坏/权限→throw |
| `src/rpc/create-rpc-handlers.ts` | 聚合 `createModelMetaHandlers` |

### apps/web

| 文件 | 改动 |
|---|---|
| `src/lib/desktop-api/` | `getModelMeta()` = `sidecarCall(MODEL_META_IPC_CHANNELS.GET)` |
| `src/.../ModelMetaContext.tsx`（新） | `ModelMetaProvider`：mount 时 `getModelMeta()`→`setModelMeta`+bump（不阻塞渲染）；`useModelMetaVersion()` |
| App 根组件 | 包裹 `<ModelMetaProvider>` |
| 6 处消费者 | `useMemo` 依赖加 `useModelMetaVersion()` |

## 6. sidecar handler 与错误处理

### 6.1 GET handler

```ts
// apps/sidecar/src/rpc/model-meta-handlers.ts
import { MODEL_META_IPC_CHANNELS } from "@lume/shared"
import { getConfigDir } from "../services/infra/config-paths"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { RpcHandler } from "./types"

const GENERATED_FILE = "model-meta.generated.json"

export function createModelMetaHandlers(): Record<string, RpcHandler> {
  return {
    [MODEL_META_IPC_CHANNELS.GET]: async () => {
      const filePath = join(getConfigDir(), GENERATED_FILE)
      try {
        return JSON.parse(await readFile(filePath, "utf8")) // ModelMeta[]
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
  }
}
```

返回 `ModelMeta[] | null`（未 merge）。

### 6.2 错误处理矩阵

| 场景 | sidecar GET | web ModelMetaProvider |
|---|---|---|
| 首次启动（config dir 无文件） | ENOENT → `null` | 保持 seed，不 bump |
| 有合法文件 | 返回 `ModelMeta[]` | `setModelMeta` + bump |
| JSON 损坏 | throw | catch → 保持 seed + toast |
| sidecar 未就绪/超时 | invoke reject | catch → 保持 seed（静默） |

seed fallback 红利：任何 sidecar 失败，web 都有 seed 可用，UI 不崩。

## 7. 测试策略

测试用 bun:test（web/desktop 约定），组件测试参考 `AgentView.test.tsx` fake DOM 模式。

| 单元 | 测试点 |
|---|---|
| `model-meta.ts` mutable registry | `setModelMeta` 后 `findModelMeta` 返回新数据；重建 lookupMap（alias 正确）；无 `setModelMeta` 调用时初始化用 seed（向后兼容） |
| `catalog-mapping.ts` `buildGeneratedFromCatalog` | 迁移现有 sync-models 测试：白名单过滤 + canonical 去重 + 字典序 |
| sidecar GET handler | 有文件→返回 parsed；ENOENT→`null`；JSON 损坏→throw；临时目录 mock `getConfigDir` |
| `ModelMetaContext` | mount→`getModelMeta`→`setModelMeta`+bump；`null`→保持 seed；version 变更触发消费者重算 |
| 6 处消费者 | 类型保证 + verify：version bump 后 `useMemo` 重算拿新 meta |

## 8. A / B 边界

- **A（本 spec）**：mutable registry + seed fallback + `buildGeneratedFromCatalog` 迁移 + sidecar `GET` handler + `MODEL_META_IPC_CHANNELS.GET` 常量 + web bootstrap（seed 优先）+ version Context + 6 处消费者接入。A 自洽可验证：无 B 时系统正常工作（seed 启动，GET 返回 seed/config）。
- **B（后续 spec）**：`MODEL_META_IPC_CHANNELS.SYNC` + sidecar sync handler（fetch+build+原子写 config dir）+ `DataManagementSettings` 第⑤卡按钮 + 按钮调 sync→`setModelMeta`→bump。

## 9. 待 plan 阶段实证的点

- `MODEL_META_IPC_CHANNELS` 枚举具体落哪个 types 文件（新建 `types/model-meta.ts` 或并入现有），确保从 `@lume/shared` 根 export。
- `ModelMetaProvider` 在 App 根的具体挂载位置（与现有 Provider 层级关系）。
- `setModelMeta` 是否需并发守卫（JS 单线程，`let` 引用替换原子，预期无需锁——plan 确认）。
- 6 处消费者 `useMemo` 依赖注入的统一 hook 形态。

## 10. 关联

- 前置 spec：`docs/superpowers/specs/2026-07-07-models-dev-sync-design.md`
- memory：`lume-model-meta-runtime-data-source`、`lume-models-dev-sync-feature`
- IPC 模式参考：channel 常量（`packages/shared/src/types/agent.ts:1297` 邻近枚举）→ sidecar `RpcHandler` factory（`apps/sidecar/src/rpc/channel-handlers.ts:16`）→ `sidecar_call` 桥（`apps/web/src/lib/desktop-api/system.ts:20`）→ Electron main 路由（`apps/desktop/src/main.ts:491`）
