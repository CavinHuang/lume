# 技能添加来源选择弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在技能设置页点击"添加技能"时，弹出选择对话框，让用户从三个来源中选择：市场订阅技能、内置技能、或手动创建空白技能

**Architecture:** 新建一个 `SkillAddSourceDialog` 弹窗组件，包含三个选项卡片（市场、内置、手动创建）。`SkillSettingsView` 不再直接打开编辑器，而是先弹出此对话框。选择市场时跳转到市场页面；选择内置技能时从目录中挑选并一键安装；选择手动创建则打开空白编辑器。

**Tech Stack:** React, TypeScript, Base UI Dialog (shadcn), lucide-react, existing desktop-api

---

### File Structure

```
apps/web/src/components/skills/
├── SkillAddSourceDialog.tsx    # 新建：添加技能来源选择弹窗
└── SkillSettingsView.tsx       # 修改：handleCreate → 打开弹窗而非直接打开编辑器

apps/web/src/components/skills/SkillsMarketView.tsx  # 修改：接收 onOpenAddSourceDialog prop
```

---

### Task 1: 新建 `SkillAddSourceDialog` 组件

**Files:**
- Create: `apps/web/src/components/skills/SkillAddSourceDialog.tsx`
- Test: 不需要（纯 UI 组件，逻辑由父组件驱动）

- [ ] **Step 1: 编写组件**

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Globe2,
  LayoutGrid,
  Plus,
  Loader2,
  CheckCircle2,
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { SkillCatalogItem, SkillSourceType } from "@lume/shared"
import { getSkillMarketCatalog, installSkillMarketItemToWorkspace } from "@/lib/desktop-api"

export interface SkillAddSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceSlug: string | null
  /** 选择"手动创建"后的回调 */
  onCreateNew: () => void
  /** 选择"浏览市场"后的回调 */
  onOpenMarket: () => void
}

type TabKey = "market" | "built-in" | "create"

const TABS: { key: TabKey; label: string; description: string }[] = [
  {
    key: "market",
    label: "浏览市场",
    description: "从已订阅的市场源中浏览和安装技能",
  },
  {
    key: "built-in",
    label: "内置技能",
    description: "选择系统自带的内置技能直接启用",
  },
  {
    key: "create",
    label: "手动创建",
    description: "从空白编辑器开始，自定义编写技能",
  },
]

export function SkillAddSourceDialog({
  open,
  onOpenChange,
  workspaceSlug,
  onCreateNew,
  onOpenMarket,
}: SkillAddSourceDialogProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("market")
  const [items, setItems] = useState<SkillCatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)

  // 当弹窗打开时，如果是 market 或 built-in 标签，自动加载目录
  useEffect(() => {
    if (!open) return
    setActiveTab("market")
    setItems([])
    setInstallError(null)
    setInstallNotice(null)
    setInstallingSlug(null)
  }, [open])

  useEffect(() => {
    if (!open || activeTab === "create") return
    if (!workspaceSlug) return

    setLoading(true)
    setInstallError(null)
    setItems([])
    getSkillMarketCatalog(workspaceSlug)
      .then((catalog) => {
        if (activeTab === "market") {
          setItems(
            catalog.items.filter(
              (item) => item.sourceType === "subscribed-market",
            ),
          )
        } else {
          setItems(
            catalog.items.filter(
              (item) => item.sourceType === "built-in",
            ),
          )
        }
      })
      .catch((err) => {
        setInstallError(err instanceof Error ? err.message : String(err))
        setItems([])
      })
      .finally(() => setLoading(false))
  }, [open, activeTab, workspaceSlug])

  const handleInstall = useCallback(
    async (item: SkillCatalogItem) => {
      if (!workspaceSlug) return
      setInstallingSlug(item.slug)
      setInstallError(null)
      setInstallNotice(null)
      try {
        await installSkillMarketItemToWorkspace({
          workspaceSlug,
          skillId: item.id,
          overwrite: false,
        })
        setInstallNotice(`「${item.name}」安装成功`)
        // 安装成功后刷新列表
        const catalog = await getSkillMarketCatalog(workspaceSlug)
        if (activeTab === "market") {
          setItems(
            catalog.items.filter((i) => i.sourceType === "subscribed-market"),
          )
        } else {
          setItems(
            catalog.items.filter((i) => i.sourceType === "built-in"),
          )
        }
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlug(null)
      }
    },
    [workspaceSlug, activeTab],
  )

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab)
    setInstallError(null)
    setInstallNotice(null)
    setItems([])
  }

  const handleManualCreate = () => {
    onOpenChange(false)
    onCreateNew()
  }

  const handleOpenMarket = () => {
    onOpenChange(false)
    onOpenMarket()
  }

  const renderActionButton = (item: SkillCatalogItem) => {
    const isInstalling = installingSlug === item.slug

    if (item.installState === "installed") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#f0f4ec] px-2.5 py-1 text-[12px] font-medium text-[#4c7a41]">
          <CheckCircle2 size={13} />
          已安装
        </span>
      )
    }

    if (item.installState === "update-available") {
      return (
        <button
          type="button"
          disabled={isInstalling}
          onClick={() => void handleInstall(item)}
          className="flex h-8 items-center gap-1.5 rounded-[6px] bg-[#4f46e5] px-3 text-[12px] font-semibold text-white hover:bg-[#3730a3] disabled:cursor-wait disabled:opacity-60"
        >
          {isInstalling && <Loader2 size={13} className="animate-spin" />}
          更新
        </button>
      )
    }

    return (
      <button
        type="button"
        disabled={isInstalling}
        onClick={() => void handleInstall(item)}
        className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[#4f46e5] bg-white px-3 text-[12px] font-semibold text-[#4f46e5] hover:bg-[#f5f6ff] disabled:cursor-wait disabled:opacity-60"
      >
        {isInstalling && <Loader2 size={13} className="animate-spin" />}
        安装
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[#20232d]">
            添加技能
          </DialogTitle>
        </DialogHeader>

        {/* Tab 切换 */}
        <div className="flex gap-1 rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                "flex-1 rounded-[6px] px-3 py-2 text-[13px] font-semibold transition-colors",
                activeTab === tab.key
                  ? "bg-white text-[#20232d] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]"
                  : "text-[#687196] hover:text-[#20232d]",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 描述 */}
        <p className="text-[13px] leading-5 text-[#687196]">
          {TABS.find((t) => t.key === activeTab)?.description}
        </p>

        {/* 内容区 */}
        <div className="max-h-[360px] min-h-[120px] overflow-y-auto rounded-[8px] border border-[#e4e7f1]">
          {activeTab === "create" ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#f0f0f0]">
                <Plus size={22} className="text-[#687196]" />
              </div>
              <p className="text-[13px] text-[#687196]">
                从空白编辑器开始编写自定义技能
              </p>
              <button
                type="button"
                onClick={handleManualCreate}
                className="flex h-9 items-center gap-2 rounded-[8px] bg-[#2f2f31] px-4 text-[13px] font-semibold text-white hover:bg-[#1f2023]"
              >
                <Plus size={15} />
                创建空白技能
              </button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[#626b8f]">
              <Loader2 size={16} className="animate-spin" />
              正在加载...
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-[13px] text-[#687196]">
              {activeTab === "market"
                ? "当前没有已订阅的市场源，请先在市场页面添加市场源。"
                : "没有可用的内置技能。"}
              {activeTab === "market" && (
                <button
                  type="button"
                  onClick={handleOpenMarket}
                  className="text-[13px] font-semibold text-[#4f46e5] hover:text-[#3730a3]"
                >
                  前往市场添加源
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-1">
              {items.map((item) => (
                <div
                  key={item.slug}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#f7f8fb]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[#20232d]">
                      {item.name}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-[#687196]">
                        {item.description}
                      </p>
                    )}
                  </div>
                  {renderActionButton(item)}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 通知/错误 */}
        {installNotice && (
          <p className="text-[13px] leading-5 text-[#4c7a41]">{installNotice}</p>
        )}
        {installError && (
          <p className="text-[13px] leading-5 text-[#ba3636]">{installError}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 验证组件编译**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新类型错误（如果引入的文件路径正确）

---

### Task 2: 修改 `SkillSettingsView` — 用弹窗替代直接创建

**Files:**
- Modify: `apps/web/src/components/skills/SkillSettingsView.tsx`

- [ ] **Step 1: 修改 Props，接收弹窗控制参数**

修改 `SkillSettingsView` 的 props，添加 `onOpenAddSourceDialog`：

```tsx
export function SkillSettingsView({
  workspaceSlug,
  cwd,
  onOpenMarket,
  availableWorkspaces,
  onWorkspaceChange,
  onOpenAddSourceDialog,    // 新增
}: {
  workspaceSlug: string | null
  cwd?: string | null
  onOpenMarket: () => void
  availableWorkspaces?: AgentWorkspace[]
  onWorkspaceChange?: (slug: string) => void
  onOpenAddSourceDialog: () => void   // 新增
})
```

- [ ] **Step 2: 修改 `handleCreate` 为打开弹窗**

将当前 `handleCreate` 的逻辑（`setDraft(createEmptySkillDraft(...))`）替换为调用 `onOpenAddSourceDialog()`：

```tsx
const handleCreate = () => {
  // 不再直接打开编辑器，改为弹出来源选择对话框
  onOpenAddSourceDialog()
}
```

- [ ] **Step 3: 修改"添加技能"按钮保持原样**

按钮的 `onClick={handleCreate}` 无需改动，行为已被 handleCreate 内部逻辑改变。

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新类型错误

---

### Task 3: 修改 `SkillsMarketView` — 传递弹窗控制

**Files:**
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`

- [ ] **Step 1: 新增状态控制弹窗**

在 `SkillsMarketView` 组件中，在 `[detailOpen, setDetailOpen]` 之后添加：

```tsx
const [addSourceDialogOpen, setAddSourceDialogOpen] = useState(false)
```

- [ ] **Step 2: 将 `SkillsMarketView` 的 `onOpenMarket` prop 传递给 `SkillSettingsView`**

找到渲染 `<SkillSettingsView` 的位置（在文件后半部分），确认已有 `onOpenMarket={setActiveSection.bind(null, 'market')}` 或类似逻辑。如果 `onOpenMarket` 已正确传递，无需改动。

- [ ] **Step 3: 将 `onOpenAddSourceDialog` 传递给 `SkillSettingsView`**

```tsx
<SkillSettingsView
  workspaceSlug={workspaceSlug}
  cwd={settingsCwd}
  onOpenMarket={() => setActiveSection('market')}
  onOpenAddSourceDialog={() => setAddSourceDialogOpen(true)}   // 新增
  availableWorkspaces={workspaces}
  onWorkspaceChange={handleWorkspaceChange}
/>
```

- [ ] **Step 4: 在 `SkillsMarketView` 的 return 中渲染 `SkillAddSourceDialog`**

在组件 return 的顶层添加：

```tsx
<SkillAddSourceDialog
  open={addSourceDialogOpen}
  onOpenChange={setAddSourceDialogOpen}
  workspaceSlug={workspaceSlug}
  onCreateNew={() => setActiveSection('settings')}
  onOpenMarket={() => setActiveSection('market')}
/>
```

- [ ] **Step 5: 导入新组件**

在 `SkillsMarketView.tsx` 的 import 区域添加：

```tsx
import { SkillAddSourceDialog } from './SkillAddSourceDialog'
```

- [ ] **Step 6: 验证编译**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新类型错误

---

### Task 4: 端到端验证

- [ ] **Step 1: 启动开发服务器**

Run: `pnpm dev` (或项目使用的启动命令)
Expected: 开发服务器正常启动，无编译错误

- [ ] **Step 2: 手动验证流程**

1. 打开应用，进入技能设置页面
2. 点击"添加技能"按钮
3. 验证弹窗出现，包含三个 Tab（浏览市场、内置技能、手动创建）
4. 验证"手动创建"Tab 有"创建空白技能"按钮，点击后弹窗关闭并打开空白编辑器
5. 验证"浏览市场"Tab 列出已订阅的市场技能，点击"安装"可以安装
6. 验证"浏览市场"Tab 无已订阅源时显示引导文字和"前往市场添加源"链接
7. 验证"内置技能"Tab 列出系统内置技能，点击"安装"可以安装
8. 验证安装后列表自动刷新，已安装技能显示"已安装"标签
9. 验证"浏览市场"Tab 中"前往市场添加源"链接能正确跳转到市场页面

---

## Self-Review

### 1. Spec coverage
- [x] 技能设置页点击"添加技能"弹出选择对话框 → Task 2 + Task 1
- [x] 可选择添加市场上订阅的技能 → Task 1 (market tab)
- [x] 可选择内置技能 → Task 1 (built-in tab)
- [x] 可选择自己创建技能 → Task 1 (create tab)

### 2. Placeholder scan
- [x] 无 "TBD"、"TODO" 等占位符
- [x] 所有步骤包含完整代码
- [x] 类型定义引用自已有共享类型

### 3. Type consistency
- [x] `SkillAddSourceDialogProps` 中回调类型与 `SkillSettingsView` 中的 `onOpenMarket` 签名一致
- [x] `TabKey` 类型在各任务中统一使用
- [x] `SkillCatalogItem` 和 `SkillSourceType` 来自 `@lume/shared` 共享类型
