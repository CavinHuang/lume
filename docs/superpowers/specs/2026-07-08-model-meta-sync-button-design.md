# model-meta「更新模型数据」按钮（子项目 B）

- **日期**: 2026-07-08
- **状态**: 待实现（设计已批准）
- **关联**: `2026-07-08-model-meta-runtime-data-source-design.md`（前置——子项目 A 运行时加载层，本设计是其 UI 入口）、memory `lume-model-meta-runtime-data-source`

## 1. 背景与现状

子项目 A（model-meta 运行时数据源，2026-07-08，commits 05a4ed74 docs + 63eb9d56 feat）已完成：mutable registry + `setModelMeta` + sidecar GET handler + `ModelMetaContext`（`useModelMetaVersion` + `useModelMetaReload` + `applyModelMetaUpdate`）+ 6 处消费者接入。registry 现可在运行时替换，但**尚无用户触发改写的入口**——config dir 的 generated.json 只能由开发期 sync 脚本写。

**目标场景**：在「设置 → 数据管理」加「更新模型数据」按钮，用户点击后 sidecar 从 models.dev 拉取最新 catalog、生成 generated、原子写入 config dir、热更新到 web（无需重启 app、无需等版本发布）。

**现状消费**（已核实）：`DataManagementSettings.tsx`（389 行）现有卡片 ①-④（存储概览/清理/导出/数据位置）+ 未编号 danger 卡（清空回收站）+ 迁移 Dialog。按钮交互沿用 `handleClear` 模式（useState 布尔 + Loader2 替换图标 + sonner toast + finally）。`MODEL_META_IPC_CHANNELS` 仅 `GET`（`packages/shared/src/types/model-meta.ts`），无 SYNC。

## 2. 目标 / 非目标

**目标**

- 新增 `MODEL_META_IPC_CHANNELS.SYNC` + sidecar SYNC handler（fetch models.dev + buildGenerated + 原子写 config dir + 返回未 merge 的 generated）。
- DataManagementSettings 第⑤卡「更新模型数据」按钮，调 sync → `useModelMetaReload(generated)` → 6 处消费者热更新。
- loading / toast 沿用现有模式。

**非目标（YAGNI）**

- 不做进度反馈（单次 fetch 几秒，loading 足够）。
- 不需 relaunch（A 的 version Context 热更）。
- 不改 A 的任何接口/行为（B 只消费 A 的 `useModelMetaReload`）。
- 不做定时自动同步（用户主动触发）。
- 不改 `ModelMeta` 字段结构。

## 3. 已定决策

1. **fetch 归属：sidecar**。CSP 虽允许 web fetch https，但写 generated.json 需 fs（sandbox renderer 无 fs）；与 `getModelMeta` 读路径对称；与 `emptyTrash`/`clearCache` 的 sidecar 模式一致。
2. **fetch 用 `fetchWithProxy`**（`apps/sidecar/src/services/infra/proxy-fetch.ts:87`）：尊重用户代理设置 + curl 路径 `--max-time 20s --connect-timeout 12s`。
3. **复用 `buildGeneratedFromCatalog`**（`@lume/shared`，A Task 2 产物）——纯函数，sidecar import。`fetchCatalog` 不迁 shared（shared 不依赖 sidecar 的 proxy-fetch），SYNC handler 内联 `fetchWithProxy` + `buildGeneratedFromCatalog`。
4. **原子写**：先写 tmp 文件（同目录 `.tmp` 后缀），成功后 `rename` 覆盖 generated.json（避免中途失败污染现有文件；对齐 `sync-models.ts`「先序列化再落盘」思路并升级为 tmp+rename）。
5. **返回未 merge 的 generated**（A 决策 6）：sidecar 永远返回原始 generated，merge 只在 web `setModelMeta` 内。
6. **UI 沿用 `handleClear` 模式**（`DataManagementSettings.tsx:79-91`）：useState 布尔 `syncing` + Loader2 替换图标 + sonner toast + finally。无进度、无 relaunch。
7. **pull 模式**（A 决策 5）：sync 响应直接带 generated，web `useModelMetaReload(generated)`，无 push 事件、无二次 getModelMeta。

## 4. 架构与数据流

```
① 用户点「立即更新」
   DataManagementSettings handleSyncModelMeta:
     setSyncing(true)
     → syncModelMeta()                                       // sidecarCall('model-meta:sync')
       → sidecar SYNC handler:
           const res = await fetchWithProxy(CATALOG_URL)     // proxy-fetch.ts:87
           if (!res.ok) throw new Error(`fetch models.dev: HTTP ${res.status}`)
           const catalog = (await res.json()) as Catalog
           const generated = buildGeneratedFromCatalog(catalog)   // @lume/shared (A Task 2)
           await atomicWriteGenerated(join(getConfigDir(), GENERATED_FILE), generated)  // tmp+rename
           return generated                                  // 未 merge
     → useModelMetaReload(generated)                         // A: setModelMeta + bump version → 6 处消费者重算
     → toast.success(`已更新 ${generated.length} 个模型`)
     catch (e) → toast.error(`更新失败：${msg}`)
     finally → setSyncing(false)
```

## 5. 组件改动清单

### packages/shared

| 文件 | 改动 |
|---|---|
| `src/types/model-meta.ts` | `MODEL_META_IPC_CHANNELS` 加 `SYNC: "model-meta:sync"` |

### apps/sidecar

| 文件 | 改动 |
|---|---|
| `src/rpc/model-meta-handlers.ts` | 加 SYNC handler（`fetchWithProxy` + `buildGeneratedFromCatalog` + 原子写 + 返回 generated）；import `fetchWithProxy` from `../services/infra/proxy-fetch`、`buildGeneratedFromCatalog` + `Catalog` type from `@lume/shared` |

### apps/web

| 文件 | 改动 |
|---|---|
| `src/lib/desktop-api/model.ts` | 加 `syncModelMeta()` = `sidecarCall<ModelMeta[]>(MODEL_META_IPC_CHANNELS.SYNC, {})` |
| `src/components/settings/DataManagementSettings.tsx` | 第⑤卡「更新模型数据」：`syncing` useState + `handleSyncModelMeta` + UI（插在 ④ L282 与 danger 卡 L284 之间）；import `syncModelMeta` + `useModelMetaReload` |

## 6. sidecar SYNC handler 细节

```ts
// apps/sidecar/src/rpc/model-meta-handlers.ts（在 A 的 GET handler 基础上追加）
import { fetchWithProxy } from "../services/infra/proxy-fetch"
import { buildGeneratedFromCatalog, MODEL_META_IPC_CHANNELS, type Catalog } from "@lume/shared"
import { writeFile, rename } from "node:fs/promises"
import { join } from "node:path"

const CATALOG_URL = "https://models.dev/catalog.json"

/** 原子写：先写 .tmp 再 rename 覆盖，避免中途失败污染现有文件 */
async function atomicWriteGenerated(targetPath: string, generated: ModelMeta[]): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8")
  await rename(tmpPath, targetPath)
}

// 在 createModelMetaHandlers() 返回对象里追加（与 GET 并列）：
[MODEL_META_IPC_CHANNELS.SYNC]: async () => {
  const res = await fetchWithProxy(CATALOG_URL)
  if (!res.ok) throw new Error(`fetch models.dev: HTTP ${res.status}`)
  const catalog = (await res.json()) as Catalog
  const generated = buildGeneratedFromCatalog(catalog)
  await atomicWriteGenerated(join(getConfigDir(), GENERATED_FILE), generated)
  return generated // 未 merge
}
```

错误处理：fetch 失败 / 解析失败 / 写失败 → throw → web catch → toast.error。

## 7. UI 交互（第⑤卡）

插在 ④ 数据位置（L282）与 danger 卡清空回收站（L284）之间——保持 danger 卡始终在末尾。

```tsx
{/* ⑤ 更新模型数据 */}
<section className="lume-panel-padded">
  <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">更新模型数据</h2>
  <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
    从 models.dev 同步最新模型元数据（定价、上下文窗口、能力标记）。更新后立即生效，无需重启。
  </p>
  <div className="flex justify-end">
    <button onClick={handleSyncModelMeta} disabled={syncing} className="...">
      {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
      {syncing ? "更新中…" : "立即更新"}
    </button>
  </div>
</section>
```

`handleSyncModelMeta` 见 §4 数据流；`syncing` 为 useState 布尔。

## 8. 测试策略

测试用 bun:test，sidecar handler 测试用 `LUME_CONFIG_DIR` env 注入临时目录（同 A Task 4）。

| 单元 | 测试点 |
|---|---|
| `MODEL_META_IPC_CHANNELS.SYNC` 常量 | 值 = `'model-meta:sync'`（扩展现有 `types/model-meta.test.ts`） |
| sidecar SYNC handler | mock `fetchWithProxy`（返回 mini catalog Response）→ 返回 generated + 验证 config dir 文件内容 = `buildGeneratedFromCatalog` 输出；fetch !ok → throw；原子写（成功后 `.tmp` 不残留）。写失败用只读目录 mock 较脆，可选 |
| `syncModelMeta` / `handleSyncModelMeta` | 薄包装 + 组件交互，靠类型 + verify（fakeDom 组件测试 YAGNI） |

> SYNC handler 测试 mock `fetchWithProxy`（而非真连 models.dev）——保证测试离线、确定性。`buildGeneratedFromCatalog` 输出正确性已在 A Task 2 的 `catalog-mapping.test.ts` 覆盖（8 用例），B 不重复测。

## 9. 关联

- 前置 spec：`docs/superpowers/specs/2026-07-08-model-meta-runtime-data-source-design.md`（子项目 A）
- memory：`lume-model-meta-runtime-data-source`
- A 预留接口：`useModelMetaReload(generated?)`（`apps/web/src/lib/model-meta-context.tsx`）、`MODEL_META_IPC_CHANNELS`（`packages/shared/src/types/model-meta.ts`）
- 模式参考：`handleClear`（`DataManagementSettings.tsx:79-91`）、`fetchWithProxy`（`apps/sidecar/src/services/infra/proxy-fetch.ts:87`）、`buildGeneratedFromCatalog`（`packages/shared/src/data/catalog-mapping.ts`）
