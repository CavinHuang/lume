# 模型设置支持自定义添加模型 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页的渠道表单（ChannelForm）中，除了「拉取模型列表」，新增「手动添加模型」能力，并让再次拉取时按 id 合并保留手动添加的模型。

**Architecture:** 纯前端改动，仅修改 `apps/web/src/components/settings/ChannelForm.tsx`。后端零改动——`ChannelModel` 字段已够用，`channel:update` IPC 本就接受任意 `models[]`。新增一个导出的纯函数 `mergeChannelModels`（TDD 覆盖），把 `handleFetchModels` 的「全量替换」改为「合并去重」，再新增「手动添加」按钮 + 内联展开输入区，复用共享包已有的 `normalizeChannelModel` 规整手动添加的模型。

**Tech Stack:** React 18 + TypeScript + Tailwind v4 + shadcn/ui（Button/Input/Label）；共享包 `@lume/shared`；测试用 `bun:test`；包管理器 bun 1.3.13。

**Spec:** `docs/superpowers/specs/2026-06-13-custom-model-add-design.md`

---

## File Structure

- **Modify:** `apps/web/src/components/settings/ChannelForm.tsx`
  - 新增导出的纯函数 `mergeChannelModels`（与现有 `filterChannelModels` 并列）
  - 修改 `handleFetchModels`：替换 → 合并
  - 新增 imports：`normalizeChannelModel`（from `@lume/shared`）、`Plus`（from `lucide-react`）
  - 新增 state：`showAddModel` / `newModelId` / `newModelName` / `addError`
  - 新增 `handleAddModel` handler
  - 修改模型区 JSX：标题行加「手动添加」按钮 + 展开的输入区
  - 在 `useEffect` 重置分支里清空新增 state
- **Create:** `apps/web/src/components/settings/channel-form.test.ts`
  - 用 `bun:test` 测 `mergeChannelModels`（参照同目录惯例 `model-selection/model-selection-state.test.ts`）

> 关于错误提示色：项目现有次要文本统一用 `text-muted-foreground`（见 `ChannelForm.tsx` 的 `fetchMsg`），未见语义错误色先例。本计划错误提示用 Tailwind v4 标准 `text-red-500`（必然可用）。如项目后续引入语义错误色 token 可统一替换。

---

## Task 1: 新增并测试 `mergeChannelModels` 纯函数

**Files:**
- Create: `apps/web/src/components/settings/channel-form.test.ts`
- Modify: `apps/web/src/components/settings/ChannelForm.tsx`（新增导出函数，位于 `filterChannelModels` 上方/附近，约第 34 行前）

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/settings/channel-form.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@lume/shared'
import { mergeChannelModels } from './ChannelForm'

const m = (id: string, name = id, enabled = true): ChannelModel => ({ id, name, enabled })

describe('mergeChannelModels', () => {
  test('returns fetched list when there is nothing to preserve', () => {
    expect(mergeChannelModels([], [m('gpt-4o')])).toEqual([m('gpt-4o')])
  })

  test('preserves manually-added models that the fetch did not return', () => {
    const existing = [m('gpt-4o'), m('my-custom-model')]
    const fetched = [m('gpt-4o'), m('gpt-4o-mini')]
    const merged = mergeChannelModels(existing, fetched)
    expect(merged.map((x) => x.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'my-custom-model'])
  })

  test('fetched overrides an existing model with the same id', () => {
    const existing = [m('dup', 'Manual Name', true)]
    const fetched = [m('dup', 'Fetched Name', false)]
    expect(mergeChannelModels(existing, fetched)).toEqual([m('dup', 'Fetched Name', false)])
  })

  test('returns empty when both inputs are empty', () => {
    expect(mergeChannelModels([], [])).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/web && bun test src/components/settings/channel-form.test.ts`
Expected: FAIL — `mergeChannelModels is not a function`（或导入失败，因为尚未定义/导出）。

- [ ] **Step 3: 实现 `mergeChannelModels`**

在 `apps/web/src/components/settings/ChannelForm.tsx` 中，找到现有导出函数 `filterChannelModels`（约第 34 行），在其**上方**新增：

```ts
export function mergeChannelModels(existing: ChannelModel[], fetched: ChannelModel[]): ChannelModel[] {
  const fetchedIds = new Set(fetched.map((m) => m.id))
  const preserved = existing.filter((m) => !fetchedIds.has(m.id))
  return [...fetched, ...preserved]
}
```

> `ChannelModel` 类型已在文件顶部 import（`import type { ... ChannelModel ... } from '@lume/shared'`），无需额外 import。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/web && bun test src/components/settings/channel-form.test.ts`
Expected: PASS（4 个 test 全过）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/settings/channel-form.test.ts apps/web/src/components/settings/ChannelForm.tsx
git commit -m "feat(web): add mergeChannelModels helper with tests"
```

---

## Task 2: `handleFetchModels` 改为「合并去重」

**Files:**
- Modify: `apps/web/src/components/settings/ChannelForm.tsx`（`handleFetchModels`，约第 125-141 行）

- [ ] **Step 1: 修改 `handleFetchModels` 的成功分支**

找到 `handleFetchModels` 内的成功分支（约第 130-132 行）：

```ts
      if (r.success) {
        setModels(r.models)
        setFetchMsg(`获取到 ${r.models.length} 个模型`)
      }
```

替换为：

```ts
      if (r.success) {
        setModels((prev) => mergeChannelModels(prev, r.models))
        setFetchMsg(`获取到 ${r.models.length} 个模型`)
      }
```

> 仅改这一行：`setModels(r.models)` → `setModels((prev) => mergeChannelModels(prev, r.models))`。`mergeChannelModels` 已在 Task 1 同文件定义。

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 通过，无报错。

- [ ] **Step 3: 确认既有测试仍通过**

Run: `cd apps/web && bun test src/components/settings/channel-form.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/settings/ChannelForm.tsx
git commit -m "feat(web): merge fetched models with manually-added ones instead of replacing"
```

---

## Task 3: 「手动添加模型」UI 与逻辑

**Files:**
- Modify: `apps/web/src/components/settings/ChannelForm.tsx`（imports、state、`useEffect` 重置、新增 `handleAddModel`、模型区 JSX）

- [ ] **Step 1: 新增 imports**

在 `apps/web/src/components/settings/ChannelForm.tsx` 顶部：

第 2 行 lucide-react import，把 `Plus` 加进去：

```ts
import { Eye, EyeOff, Loader2, Plus } from 'lucide-react'
```

第 4 行 `@lume/shared` 值 import，把 `normalizeChannelModel` 加进去：

```ts
import { PROVIDER_LABELS, PROVIDER_DEFAULT_URLS, normalizeChannelModel } from '@lume/shared'
```

- [ ] **Step 2: 新增 state**

找到现有 state 区（约第 86 行 `const [showApiKey, setShowApiKey] = useState(false)`），在其后新增：

```ts
  const [showAddModel, setShowAddModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newModelName, setNewModelName] = useState('')
  const [addError, setAddError] = useState('')
```

- [ ] **Step 3: 在 `useEffect` 重置分支里清空新增 state**

找到重置 `initialValue` 的 `useEffect`（约第 88-113 行）。两个分支（`!initialValue` 和有 `initialValue`）都需清空新增 state。

`!initialValue` 分支末尾（原 `setProviderId('')` 所在分支，约第 99 行后），在 `return` 之前补：

```ts
      setShowAddModel(false)
      setNewModelId('')
      setNewModelName('')
      setAddError('')
      return
```

有 `initialValue` 分支末尾（原 `setProviderId(initialValue.providerId ?? '')` 之后，约第 112 行后）补：

```ts
    setShowAddModel(false)
    setNewModelId('')
    setNewModelName('')
    setAddError('')
```

- [ ] **Step 4: 新增 `handleAddModel` handler**

在 `handleFetchModels`（约第 141 行结束）之后新增：

```ts
  const handleAddModel = () => {
    const id = newModelId.trim()
    if (!id) {
      setAddError('请输入模型 ID')
      return
    }
    if (models.some((model) => model.id === id)) {
      setAddError('该模型已存在')
      return
    }
    const name = newModelName.trim() || id
    const normalized = normalizeChannelModel({ id, name, enabled: true, provider })
    setModels((prev) => [...prev, normalized])
    setNewModelId('')
    setNewModelName('')
    setAddError('')
    setShowAddModel(false)
  }
```

> `normalizeChannelModel` 签名为 `(input: ChannelModel & { provider: ProviderType; supportedGenerationMethods?: string[] })`。传入 `{ id, name, enabled: true, provider }` 满足 `ChannelModel` 必填字段（id/name/enabled）；它会 trim、name 兜底、并按 provider 推断 chat/embedding 能力。

- [ ] **Step 5: 修改模型区 JSX —— 标题行加「手动添加」按钮**

找到模型区标题行（约第 286-293 行）：

```tsx
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>模型</Label>
          <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={disabled || fetching || (apiKeyRequired && !apiKey)}>
            {fetching && <Loader2 size={11} className="animate-spin mr-1" />}
            拉取模型列表
          </Button>
        </div>
        {fetchMsg && <p className="text-[11px] text-muted-foreground">{fetchMsg}</p>}
```

替换为（把两个按钮包进一个 flex 容器，并在 fetchMsg 前插入可展开的输入区）：

```tsx
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>模型</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setShowAddModel((v) => !v); setAddError('') }}
              disabled={disabled}
            >
              <Plus size={11} className="mr-1" />
              手动添加
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={disabled || fetching || (apiKeyRequired && !apiKey)}>
              {fetching && <Loader2 size={11} className="animate-spin mr-1" />}
              拉取模型列表
            </Button>
          </div>
        </div>
        {showAddModel && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="space-y-1">
              <Label className="text-[11px]">模型 ID</Label>
              <Input
                value={newModelId}
                onChange={(e) => { setNewModelId(e.target.value); setAddError('') }}
                placeholder="claude-sonnet-4-5"
                className="font-mono text-[12px] h-8"
                disabled={disabled}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">显示名（可选）</Label>
              <Input
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder={newModelId.trim() || '默认使用模型 ID'}
                className="text-[12px] h-8"
                disabled={disabled}
              />
            </div>
            {addError && <p className="text-[11px] text-red-500">{addError}</p>}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={handleAddModel} disabled={disabled}>添加</Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setShowAddModel(false); setNewModelId(''); setNewModelName(''); setAddError('') }}
              >
                取消
              </Button>
            </div>
          </div>
        )}
        {fetchMsg && <p className="text-[11px] text-muted-foreground">{fetchMsg}</p>}
```

- [ ] **Step 6: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 通过，无报错。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/settings/ChannelForm.tsx
git commit -m "feat(web): allow manually adding custom models to a channel"
```

---

## Task 4: 验证（类型检查 + 手动验证清单）

**Files:** 无新增改动，仅运行验证。

- [ ] **Step 1: 全量类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 通过。

- [ ] **Step 2: 单测全过**

Run: `cd apps/web && bun test src/components/settings/channel-form.test.ts`
Expected: PASS（4 个 test）。

- [ ] **Step 3: 启动应用并手动验证**

启动（任选其一）：
- 桌面端：根目录 `bun run dev`（同时起 web + desktop）
- 仅 web：`cd apps/web && bun run dev`（端口 3000）

逐项验证（对应 spec 验证标准）：
1. 进入「设置 → 模型」，选中任意一个渠道（如 anthropic / openai / custom）进入 `ChannelForm` 编辑态。
2. 点「+ 手动添加」→ 输入模型 ID（如 `my-test-model`）→ 留空显示名 → 点「添加」。确认该模型出现在列表中、默认勾选、显示名为 ID。
3. 再点「+ 手动添加」→ 输入相同 ID → 确认提示「该模型已存在」、不重复添加。
4. 填写显示名后再添加一个模型，确认显示名生效。
5. 点「拉取模型列表」（需已填可用 Base URL / API Key）：确认手动添加且厂商未返回的模型仍在；厂商返回的模型正常出现。
6. 点「保存修改」→ 退出再进编辑该渠道：确认手动添加的模型持久存在。
7. 进入对话页，打开 `ModelPicker`：确认能选到手动添加的模型。

- [ ] **Step 4: 收尾**

如全部通过，本功能完成。无需额外提交（前面 Task 1-3 已分别提交）。

---

## Self-Review（已执行）

**Spec coverage：**
- 入口交互（按钮→内联展开）：Task 3 Step 5 ✓
- 拉取合并保留（按 id 去重）：Task 1（函数）+ Task 2（接线）✓
- 适用范围（所有渠道）：`ChannelForm` 对所有 provider 渲染同一模型区，Task 3 不加 provider 限制 ✓
- 复用 `normalizeChannelModel` 规整：Task 3 Step 4 ✓
- 测试 `mergeChannelModels`：Task 1 ✓
- 验证标准 7 项：Task 4 Step 3 覆盖 ✓

**Placeholder scan：** 无 TBD/TODO，每个改动步骤均含完整代码。✓

**Type consistency：** `mergeChannelModels(existing: ChannelModel[], fetched: ChannelModel[]): ChannelModel[]` 在 Task 1 定义，Task 2 调用签名一致；`handleAddModel` 调用 `normalizeChannelModel({ id, name, enabled: true, provider })` 与共享包签名一致。✓
