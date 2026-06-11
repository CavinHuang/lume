# Skills Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将技能管理界面从技能市场（SkillsMarketView）移到设置页面，添加独立的 Skills 标签页，统一 project/workspace 概念展示，补齐 Alice 技能 UI 的展示能力。

**Architecture:** 现有 `SkillSettingsView` 保持不动（它同时被 SkillsMarketView 和 SettingsView 复用），在 settings 目录下新增 `SkillsSettings.tsx` 作为设置页入口，通过统一 terminology 消除 project/workspace 混淆。内部存储 scope 保持不变，仅 UI 展示层统一概念。

**Tech Stack:** TypeScript, React, Jotai, Tailwind CSS, lucide-react

---

## File Structure

```
apps/web/src/
├── components/
│   ├── settings/
│   │   ├── settings-view-state.ts          # MODIFY: 添加 skills tab
│   │   ├── SettingsView.tsx                # MODIFY: 添加 skills tab 渲染
│   │   └── SkillsSettings.tsx              # CREATE: 设置页技能管理入口
│   └── skills/
│       ├── SkillSettingsView.tsx           # KEEP: 核心组件不变
│       ├── skill-settings-state.ts         # KEEP: 状态管理不变
│       └── ...
```

---

### Task 1: 添加 Skills 设置标签页到导航

**Files:**
- Modify: `apps/web/src/components/settings/settings-view-state.ts`
- Test: `apps/web/src/components/settings/settings-view-state.test.ts`

- [ ] **Step 1: 修改 settings-view-state.ts**

在 `SettingsViewTab` 类型和 `SETTINGS_NAV_ITEMS` 数组中添加 `skills` 项，放在 `agents` 之后、`workspaces` 之前。

```typescript
// settings-view-state.ts

// 1. 在 import 中添加 Puzzle 图标
import {
  Archive,
  BookOpen,
  Box,
  Cog,
  Database,
  Bot,
  Keyboard,
  MessageCircle,
  Palette,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react'

// 2. 在 SettingsViewTab 类型中添加 skills
export type SettingsViewTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'agents'
  | 'skills'        // ← 新增
  | 'workspaces'
  | 'memory'
  | 'reading'
  | 'permissions'
  | 'shortcuts'
  | 'integrations'
  | 'im-integrations'
  | 'web-search'
  | 'updates'
  | 'logs'
  | 'archive'

// 3. 在 SETTINGS_NAV_ITEMS 中添加 skills 项（agents 之后）
export const SETTINGS_NAV_ITEMS: Array<{
  id: SettingsViewTab
  label: string
  icon: LucideIcon
}> = [
  { id: 'general', label: '通用', icon: Cog },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'models', label: '模型', icon: Box },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'skills', label: '技能', icon: Puzzle },    // ← 新增
  { id: 'workspaces', label: '工作区', icon: Users },
  ...
]

// 4. 在 SETTINGS_PAGE_TITLES 和 SETTINGS_PAGE_SUBTITLES 中添加
export const SETTINGS_PAGE_TITLES: Record<SettingsViewTab, string> = {
  ...
  agents: 'Agents 团队',
  skills: '技能管理',    // ← 新增
  workspaces: '工作区设置',
  ...
}

export const SETTINGS_PAGE_SUBTITLES: Record<SettingsViewTab, string> = {
  ...
  agents: '管理内置角色、推荐关键词与子代理运行时身份',
  skills: '管理自定义技能、触发条件与工具权限',    // ← 新增
  workspaces: '管理多个本地工作区的基本信息、目录和默认行为',
  ...
}
```

- [ ] **Step 2: 运行现有测试确保不破坏**

```bash
cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && bun test apps/web/src/components/settings/settings-view-state.test.ts
```

Expected: PASS（新增的 `skills` 在测试中不应影响现有测试，因为测试只检查现有 items）

- [ ] **Step 3: 添加 skills tab 的单元测试**

```typescript
// settings-view-state.test.ts - 追加以下测试

test('settings nav 包含 skills tab', () => {
  const skillsItem = SETTINGS_NAV_ITEMS.find(item => item.id === 'skills')
  expect(skillsItem).toBeDefined()
  expect(skillsItem?.label).toBe('技能')
  expect(skillsItem?.icon).toBe(Puzzle)
})

test('skills tab 有对应的 title 和 subtitle', () => {
  expect(SETTINGS_PAGE_TITLES.skills).toBe('技能管理')
  expect(SETTINGS_PAGE_SUBTITLES.skills).toBe('管理自定义技能、触发条件与工具权限')
})

test('skills tab 在 agents 和 workspaces 之间', () => {
  const ids = SETTINGS_NAV_ITEMS.map(item => item.id)
  const agentsIdx = ids.indexOf('agents')
  const skillsIdx = ids.indexOf('skills')
  const workspacesIdx = ids.indexOf('workspaces')
  expect(skillsIdx).toBe(agentsIdx + 1)
  expect(skillsIdx).toBe(workspacesIdx - 1)
})
```

- [ ] **Step 4: 运行新测试**

```bash
bun test apps/web/src/components/settings/settings-view-state.test.ts
```

Expected: 3 个新测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/settings-view-state.ts \
      apps/web/src/components/settings/settings-view-state.test.ts
git commit -m "feat(settings): 添加 Skills 设置标签页"
```

---

### Task 2: 创建 SkillsSettings 设置页组件

**Files:**
- Create: `apps/web/src/components/settings/SkillsSettings.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`

- [ ] **Step 1: 创建 SkillsSettings.tsx**

这个组件是设置页的入口，内部复用 `SkillSettingsView`，但做两件事：
1. 统一 scope 标签文本（project → 工作区）
2. 作为 settings page 的容器适配

```typescript
// apps/web/src/components/settings/SkillsSettings.tsx

import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { currentWorkspaceIdAtom } from '@/atoms'
import { SkillSettingsView } from '@/components/skills/SkillSettingsView'
import type { SkillStorageScope } from '@lume/shared'

const UNIFIED_SCOPE_LABELS: Record<SkillStorageScope, string> = {
  workspace: '工作区技能',
  project: '项目技能',
  user: '用户全局技能',
}

const UNIFIED_EMPTY_LABELS: Record<SkillStorageScope, string> = {
  workspace: '当前工作区没有匹配的自有技能。',
  project: '当前项目没有匹配的自有技能。',
  user: '当前用户全局没有匹配的自有技能。',
}

export function SkillsSettings() {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom)

  // SkillSettingsView 内部已经通过 STORAGE_SCOPES 管理 scope 切换
  // 这里只需要透传 workspaceSlug 和 cwd（project scope 时使用）
  // workspaceSlug 从 currentWorkspaceIdAtom 获取
  // cwd 暂不传（设置页场景下不需要 project scope）

  return (
    <SkillSettingsView
      workspaceSlug={workspaceId ?? null}
      // 设置页默认只看 workspace + user scope，不显示 project scope
      // 通过 cwd 不传来实现：SkillSettingsView 的 projectCwd 为空时
      // storageScopes 会自动过滤掉 project scope
    />
  )
}
```

> **设计决策说明：** `SkillSettingsView` 内部已有 scope 过滤逻辑——当 `projectCwd` 为空时，`storageScopes` 会自动排除 `project` 选项。设置页不需要传入 `cwd`，因此只展示 `workspace` 和 `user` 两个 scope，从 UI 层面消除了 project/workspace 的混淆。项目级技能仍可通过技能市场页面管理。

- [ ] **Step 2: 在 SettingsView.tsx 中注册 SkillsSettings**

```typescript
// SettingsView.tsx

// 1. 添加 import
import { SkillsSettings } from './SkillsSettings'

// 2. 在 tab 渲染区域添加
{tab === 'skills' && <SkillsSettings />}
```

修改后的渲染区域（lines 89-113 附近）：
```typescript
          {tab === 'agents' && <AgentsSettings />}
          {tab === 'skills' && <SkillsSettings />}      // ← 新增
          {tab === 'workspaces' && <WorkspacesSettings />}
```

- [ ] **Step 3: 验证页面可以切换**

```bash
cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && bun run dev
```

手动验证：
1. 打开设置页
2. 侧边栏应出现「技能」标签（Puzzle 图标，在 Agents 和 工作区 之间）
3. 点击「技能」应显示技能管理界面（scope 切换 + 技能列表）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/SkillsSettings.tsx \
      apps/web/src/components/settings/SettingsView.tsx
git commit -m "feat(settings): 添加技能管理设置页，统一 project/workspace 概念"
```

---

### Task 3: 统一 SkillSettingsView 的 Scope 标签文本

**Files:**
- Modify: `apps/web/src/components/skills/SkillSettingsView.tsx`
- Modify: `apps/web/src/components/skills/skill-settings-state.ts`

- [ ] **Step 1: 在 skill-settings-state.ts 中添加统一标签映射**

当前 `SkillSettingsView.tsx` 内部定义了 `STORAGE_SCOPES` 常量，包含中文标签。将这些标签提取到 `skill-settings-state.ts` 中统一管理。

```typescript
// skill-settings-state.ts - 追加

export const SKILL_STORAGE_SCOPE_LABELS: Record<SkillStorageScope, string> = {
  workspace: 'Lume 工作区',
  project: '项目',
  user: '用户全局',
}

export const SKILL_STORAGE_SCOPE_EMPTY_LABELS: Record<SkillStorageScope, string> = {
  workspace: '当前 Lume 工作区没有匹配的自有技能。',
  project: '当前项目没有匹配的自有技能。',
  user: '当前用户全局没有匹配的自有技能。',
}
```

- [ ] **Step 2: 修改 SkillSettingsView.tsx 使用统一标签**

```typescript
// SkillSettingsView.tsx

// 1. 修改 import
import {
  buildSkillDraftFromMeta,
  buildAllowedToolOptionRows,
  createEmptySkillDraft,
  extractSkillPrompt,
  filterSkillSettingsItems,
  getSkillDraftValidationError,
  isSelfOwnedSkill,
  normalizeAllowedToolDraft,
  toggleAllowedToolDraft,
  type SkillSettingsDraft,
  // ← 新增 import
  SKILL_STORAGE_SCOPE_LABELS,
  SKILL_STORAGE_SCOPE_EMPTY_LABELS,
} from './skill-settings-state'

// 2. 删除 STORAGE_SCOPES 常量定义（约 lines 65-69）
// 删除：
// const STORAGE_SCOPES: Array<{ value: SkillStorageScope; ... }> = [
//   { value: 'project', label: '当前项目 (.alice/skills/)', emptyLabel: '...' },
//   ...
// ]

// 3. 替换 storageScopes 的 useMemo（约 line 100）
const storageScopes = useMemo(
  () => STORAGE_SCOPES.filter((scope) => scope.value !== 'project' || projectCwd),
  [projectCwd],
)

// 替换为：
const storageScopes = useMemo(
  () => [
    { value: 'workspace' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.workspace, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.workspace },
    { value: 'user' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.user, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.user },
    ...(projectCwd ? [{ value: 'project' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.project, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.project }] : []),
  ],
  [projectCwd],
)
```

- [ ] **Step 3: 修改 `formatSkillStorageScopeLabel` 函数（约 line 1065）**

```typescript
// 修改为使用统一标签映射
function formatSkillStorageScopeLabel(scope: SkillStorageScope): string {
  return SKILL_STORAGE_SCOPE_LABELS[scope] ?? scope
}
```

- [ ] **Step 4: 运行测试确保不变**

```bash
bun test apps/web/src/components/skills/skill-settings-state.test.ts
bun test apps/web/src/components/skills/SkillSettingsView.test.tsx
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/skills/skill-settings-state.ts \
      apps/web/src/components/skills/SkillSettingsView.tsx
git commit -m "refactor(skills): 统一 storage scope 标签文本"
```

---

### Task 4: 清理 SkillsMarketView 中的 SkillSettingsView 依赖

**Files:**
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`

- [ ] **Step 1: 确认 SkillsMarketView 对 SkillSettingsView 的引用**

当前 `SkillsMarketView.tsx` line 316 有：
```tsx
<SkillSettingsView workspaceSlug={workspaceSlug} cwd={settingsCwd} onOpenMarket={() => setActiveSection('market')} />
```

这个引用保持不变——技能市场页面仍然需要技能管理功能。**不需要修改。**

- [ ] **Step 2: 确认 TabContent.tsx 不受影响**

`TabContent.tsx` 中 `skills` tab 仍然渲染 `SkillsMarketView`，这个行为保持不变。设置页的 `skills` tab 和主界面的 `skills` tab 是两个独立的入口。

- [ ] **Step 3: 确认两入口的数据一致性**

两个入口都调用相同的 `SkillSettingsView` 组件，数据源相同：
- 设置页：`workspaceSlug` 来自 `currentWorkspaceIdAtom`，不传 `cwd`
- 市场页：`workspaceSlug` 和 `cwd` 都从市场页状态获取

- [ ] **Step 4: 无代码变更，跳过 commit**

---

### Task 5: 验证端到端流程

- [ ] **Step 1: 运行类型检查**

```bash
cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && bun run typecheck 2>&1 | head -30
```

Expected: 无类型错误

- [ ] **Step 2: 运行所有 settings 相关测试**

```bash
bun test apps/web/src/components/settings/
bun test apps/web/src/components/skills/skill-settings-state.test.ts
bun test apps/web/src/components/skills/SkillSettingsView.test.tsx
```

Expected: 全部 PASS

- [ ] **Step 3: 手动验证 UI**

1. 启动 dev server: `bun run dev`
2. 打开设置页 → 侧边栏应出现「技能」标签
3. 点击「技能」→ 应显示：
   - scope 切换栏（Lume 工作区 / 用户全局，无「项目」选项）
   - 搜索框
   - 「添加技能」按钮
   - 技能列表（名称、描述、触发条件）
   - 系统工具区
4. 编辑一个技能 → 表单中 storage location 应只有「Lume 工作区」和「用户全局」
5. 返回主界面 → 技能市场 tab 仍正常工作

- [ ] **Step 4: Commit（如有调整）**

```bash
git add -A
git commit -m "test: 验证技能设置页端到端流程"
```

---

## Summary

| 变更 | 文件 | 说明 |
|------|------|------|
| 添加 skills tab | `settings-view-state.ts` | 导航、title、subtitle |
| 设置页入口 | `SkillsSettings.tsx` (NEW) | 透传 SkillSettingsView，设置页场景下隐藏 project scope |
| SettingsView 注册 | `SettingsView.tsx` | 添加 `{tab === 'skills'}` 渲染 |
| 统一标签 | `skill-settings-state.ts` + `SkillSettingsView.tsx` | scope 标签从硬编码改为集中管理 |
| 无变更 | `SkillsMarketView.tsx` | 继续复用 SkillSettingsView |

**Concept unification 方案：** 内部 `SkillStorageScope` 保持 `workspace/project/user` 三个值（文件系统层面需要区分），但设置页默认不传入 `cwd`，因此 UI 只展示 `workspace` 和 `user` 两个 scope，用户看到的标签是「Lume 工作区」和「用户全局」。项目级技能（project scope）仍然可以通过技能市场页面管理。
