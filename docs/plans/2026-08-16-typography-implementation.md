# Lume 排版体系升级 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打包 MiSans VF + JetBrains Mono 建立三族字体体系，语义字号 token 收口，对话流 measure/标题层级升级，用户可调字号档位（仅对话流），阅读页衬线重排，等宽栈三份合一。

**Architecture:** Tailwind v4 CSS-first token（`@theme` 字号/字体族 + `:root` 档位变量）；档位走既有 generalSettings 持久化链路（shared 类型 → sidecar zod/sanitize → web `chat-font-scale.ts` 写 `data-chat-font-scale` dataset）+ localStorage 首帧回退（对齐 theme-mode.ts 模式）。对话流内排版值相对量化（em/无单位行高），档位切换只改一个 CSS 变量。

**Tech Stack:** Tailwind v4、bun:test、Vite/Electron、@fontsource-variable/jetbrains-mono、自托管 MiSans VF woff2。

**Spec:** `docs/plans/2026-08-16-typography-design.md`（含实现修正：MiSans VF 来源/权重轴事实）

## Global Constraints

- 测试是 **bun:test**（不是 vitest）：web 端在 `apps/web` 跑 `bun run test:unit`；sidecar 端在 `apps/sidecar` 跑 `bun run test:unit`
- 本 worktree 无 node_modules：**任何验证前先在仓库根跑 `bun install`**
- 本 PR 自身**禁止新增 `text-[Npx]` 字号 utility**（重排版处用 `text-chat`/em/CSS 变量；既有 hardcode 不动）
- 所有 git 命令加 `rtk` 前缀；commit 信息 emoji 前缀（如 `✨ feat(web): …`），结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 不动 `agent-island/`（悬浮岛微字号是刻意设计）；不做存量 hardcode 全量替换
- **字体资产已就绪**：`apps/web/public/fonts/MiSans-VF.woff2`（11.3MB，VF wght 150-700）与 `MiSans-LICENSE.txt` 已在 worktree，无需再获取
- MiSans VF 权重上限 700；全库无 >700 字重使用（已验证零引用）
- main CI 平台测试长期红（与本次无关）；验证基线 = 本分支改动前后相关测试全绿 + typecheck 绿
- 所有路径基于 worktree 根：`D:\workspace\projects\ai-projects\lume\.claude\worktrees\typography-system`

---

### Task 1: 字体资产接线与字体族 token 统一

**Files:**
- Modify: `apps/web/src/index.css`（导入区 6-10 行、177-195 行 pre.shiki 块、521-523 行 `@theme inline`）
- Modify: `apps/web/src/components/diff/pierre-theme.ts:25`
- Modify: `apps/web/package.json`（bun add）

**Interfaces:**
- Produces: 全局 `--font-sans`（Geist + MiSans Variable + 系统回落）与 `--font-mono`（JetBrains Mono 栈）token，后续全部任务消费；`font-mono` utility（106 处既有使用）自动切换到新栈

- [ ] **Step 1: 安装依赖（worktree 首次需先 install）**

```bash
bun install
cd apps/web && rtk bun add @fontsource-variable/jetbrains-mono
```

Expected: `apps/web/package.json` dependencies 出现 `"@fontsource-variable/jetbrains-mono": "^5.3.0"`。

- [ ] **Step 2: index.css 导入区——删 Inter 死代码、加 JBM**

将 6-10 行：

```css
@import "@fontsource-variable/geist";
@import "@fontsource/inter/latin-400.css";
@import "@fontsource/inter/latin-500.css";
@import "@fontsource/inter/latin-600.css";
@import "@fontsource/inter/latin-700.css";
```

替换为：

```css
@import "@fontsource-variable/geist";
@import "@fontsource-variable/jetbrains-mono";

/* MiSans VF（wght 150-700 连续轴）：中文正文/界面字体，拉丁继续走 Geist。
   来源与授权见 public/fonts/MiSans-LICENSE.txt */
@font-face {
  font-family: 'MiSans Variable';
  font-style: normal;
  font-weight: 150 700;
  font-display: swap;
  src: url('/fonts/MiSans-VF.woff2') format('woff2');
}
```

- [ ] **Step 3: `@theme inline` 定义三族字体栈**

将 521-523 行：

```css
@theme inline {
  --font-heading: var(--font-sans);
  --font-sans: 'Geist Variable', sans-serif;
```

改为：

```css
@theme inline {
  --font-heading: var(--font-sans);
  --font-sans: 'Geist Variable', 'MiSans Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
```

- [ ] **Step 4: index.css 手写等宽栈收口**

将 183 行（`.agent-message-markdown .code-block-wrapper pre.shiki` 内）：

```css
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Code', Consolas, monospace;
```

改为：

```css
  font-family: var(--font-mono);
```

- [ ] **Step 5: pierre-theme.ts shadow DOM 等宽栈收口**

`apps/web/src/components/diff/pierre-theme.ts` 25 行：

```ts
    --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

改为：

```ts
    --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace);
```

（CSS 自定义属性可穿透 shadow DOM 继承，宿主 `--font-mono` 生效。）

- [ ] **Step 6: 验证**

```bash
cd apps/web && rtk bun run build && rtk bun run test:unit
```

Expected: `tsc --noEmit && vite build` 成功（dist 内出现 `MiSans-VF.woff2` 拷贝）；单测全绿（本次为纯 CSS/依赖变更，预期零失败）。

- [ ] **Step 7: Commit**

```bash
rtk git add -A && rtk git commit -m "✨ feat(web): MiSans/JetBrains Mono 字体打包与字体族 token 统一

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: chatFontScale 设置字段（shared 类型 + sidecar 链路）

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts:2054-2055`
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts`
- Test: `apps/sidecar/src/rpc/schemas.general-settings.test.ts`
- Test: `apps/sidecar/src/services/system/general-settings-service.test.ts`

**Interfaces:**
- Produces: `type ChatFontScale = "sm" | "md" | "lg"`（从 `@lume/shared` 导出）；`GeneralSettings.chatFontScale: ChatFontScale`（必填，DEFAULTS 为 `"md"`）；`UpdateGeneralSettingsInput.chatFontScale?`；sidecar RPC 与持久化接受该字段。Task 3/5 消费。

- [ ] **Step 1: shared 类型（先写测试期望的行为再实现——本任务测试在 Step 4/5，与实现同文件批次提交）**

`packages/shared/src/types/general-settings.ts`：

31 行 `export type AgentMessageAvatarMode = "visible" | "hidden"` 之后加：

```ts
export type ChatFontScale = "sm" | "md" | "lg"
```

`GeneralSettings` 接口 69 行 `agentMessageAvatarMode: AgentMessageAvatarMode` 之后加：

```ts
  chatFontScale: ChatFontScale
```

`UpdateGeneralSettingsInput` 86 行 `agentMessageAvatarMode?: AgentMessageAvatarMode` 之后加：

```ts
  chatFontScale?: ChatFontScale
```

`GENERAL_SETTINGS_DEFAULTS`（192 行附近）`agentMessageAvatarMode: "visible",` 之后加：

```ts
  chatFontScale: "md",
```

- [ ] **Step 2: sidecar zod schema**

`apps/sidecar/src/rpc/schemas.ts` 2054 行改为（末字段加逗号并追加）：

```ts
  agentMessageAvatarMode: z.enum(["visible", "hidden"]).optional(),
  chatFontScale: z.enum(["sm", "md", "lg"]).optional()
});
```

- [ ] **Step 3: sidecar sanitize**

`apps/sidecar/src/services/system/general-settings-service.ts`：

(a) 顶部类型导入处（第 12 行 `GENERAL_SETTINGS_DEFAULTS` 所在 import 块）追加 `type ChatFontScale`（从 `@lume/shared`，按既有 import 风格合并）。

(b) 139-141 行 `isAgentMessageAvatarMode` 函数之后加：

```ts
function isChatFontScale(value: unknown): value is ChatFontScale {
  return value === "sm" || value === "md" || value === "lg";
}
```

(c) `sanitizeGeneralSettings` 的 return（226-228 行 agentMessageAvatarMode 块）之后加：

```ts
    chatFontScale: isChatFontScale(value.chatFontScale)
      ? value.chatFontScale
      : GENERAL_SETTINGS_DEFAULTS.chatFontScale,
```

- [ ] **Step 4: 更新现有全量断言 + 新增用例**

`apps/sidecar/src/services/system/general-settings-service.test.ts`：4 处全量 `toEqual({...})` 对象（约 64、98、126、182 行，均含 `agentMessageAvatarMode: "visible",` 行）各追加一行：

```ts
      chatFontScale: "md",
```

在 describe 块末尾新增用例（复用文件内既有的 `getSettingsPath`/`clearGeneralSettingsCaches`/`updatePersistedGeneralSettings`/`readFileSync`/`writeFileSync` 导入与 LUME_CONFIG_DIR 临时目录机制；`getSettingsPath()` 无参，签名已核）：

```ts
  test("chatFontScale 可持久化，非法值回退默认", () => {
    updatePersistedGeneralSettings({ chatFontScale: "lg" });
    expect(getPersistedGeneralSettings().chatFontScale).toBe("lg");

    const settingsPath = getSettingsPath();
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      generalSettings: Record<string, unknown>;
    };
    raw.generalSettings.chatFontScale = "huge";
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
    clearGeneralSettingsCaches();
    expect(getPersistedGeneralSettings().chatFontScale).toBe("md");
  });
```

`apps/sidecar/src/rpc/schemas.general-settings.test.ts` 的 `updateGeneralSettingsInputSchema` describe 内加：

```ts
  test("chatFontScale 接受合法枚举", () => {
    const parsed = updateGeneralSettingsInputSchema.parse({ chatFontScale: "lg" });
    expect(parsed).toEqual({ chatFontScale: "lg" });
  });

  test("chatFontScale 拒绝非法枚举", () => {
    expect(() => updateGeneralSettingsInputSchema.parse({ chatFontScale: "xl" })).toThrow();
  });
```

- [ ] **Step 5: 验证（先看新用例红→实现后绿可省略：本任务实现与测试同步交付，直接跑绿）**

```bash
cd apps/sidecar && rtk bun run typecheck && rtk bun run test:unit
```

Expected: typecheck 绿（DEFAULTS 新字段会迫使 shared/sidecar 类型同步）；单测全绿，新增 3 用例通过。若 `getPersistedGeneralSettings` 的既有 `toEqual` 断言因新字段失败，即 Step 4 首段漏改，补上即可。

- [ ] **Step 6: Commit**

```bash
rtk git add -A && rtk git commit -m "✨ feat(shared,sidecar): chatFontScale 常规设置字段全链路

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 档位 web runtime 与语义字号 token

**Files:**
- Create: `apps/web/src/lib/chat-font-scale.ts`
- Create: `apps/web/src/lib/chat-font-scale.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/components/settings/general-settings-state.ts`（mergeGeneralSettings）
- Modify: `apps/web/src/index.css`（`:root` 档位变量 + `@theme` 字号 token）

**Interfaces:**
- Consumes: `ChatFontScale`（Task 2 从 `@lume/shared` 导出）
- Produces: `setChatFontScale(scale: ChatFontScale): void`、`readStoredChatFontScale(): ChatFontScale`、`isChatFontScale(value: unknown): value is ChatFontScale`；CSS 变量 `--lume-chat-font-size`/`--lume-chat-measure`；utility `text-micro`/`text-caption`/`text-ui`/`text-body`/`text-body-lg`/`text-chat`（自带行高 1.85）。Task 4/5 消费。

- [ ] **Step 1: 写失败测试**

`apps/web/src/lib/chat-font-scale.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { isChatFontScale } from './chat-font-scale'

describe('isChatFontScale', () => {
  test('接受三个合法档位', () => {
    expect(isChatFontScale('sm')).toBe(true)
    expect(isChatFontScale('md')).toBe(true)
    expect(isChatFontScale('lg')).toBe(true)
  })

  test('拒绝非法值与缺失', () => {
    expect(isChatFontScale('xl')).toBe(false)
    expect(isChatFontScale(undefined)).toBe(false)
    expect(isChatFontScale(15)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && rtk bun test src/lib/chat-font-scale.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 chat-font-scale.ts**

`apps/web/src/lib/chat-font-scale.ts`：

```ts
import { GENERAL_SETTINGS_DEFAULTS, type ChatFontScale } from '@lume/shared'

const CHAT_FONT_SCALE_STORAGE_KEY = 'lume:chat-font-scale'

export function isChatFontScale(value: unknown): value is ChatFontScale {
  return value === 'sm' || value === 'md' || value === 'lg'
}

export function setChatFontScale(scale: ChatFontScale): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CHAT_FONT_SCALE_STORAGE_KEY, scale)
  }
  if (typeof document === 'undefined') return
  // md 是默认档：不落 data 属性，CSS :root 基础值即 md
  if (scale === 'md') {
    delete document.documentElement.dataset.chatFontScale
  } else {
    document.documentElement.dataset.chatFontScale = scale
  }
}

export function readStoredChatFontScale(): ChatFontScale {
  if (typeof window === 'undefined') {
    return GENERAL_SETTINGS_DEFAULTS.chatFontScale
  }
  const value = window.localStorage.getItem(CHAT_FONT_SCALE_STORAGE_KEY)
  return isChatFontScale(value) ? value : GENERAL_SETTINGS_DEFAULTS.chatFontScale
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && rtk bun test src/lib/chat-font-scale.test.ts
```

Expected: PASS。

- [ ] **Step 5: main.tsx bootstrap 接线（首帧 localStorage 回退，防档位闪烁）**

`apps/web/src/main.tsx`：

import 区加：

```ts
import { isChatFontScale, readStoredChatFontScale, setChatFontScale } from './lib/chat-font-scale'
```

`bootstrap()` 内 24 行 `initThemeModeRuntime(...)` 之后加：

```ts
  const storedChatFontScale = readStoredChatFontScale()
  setChatFontScale(storedChatFontScale)
```

`try` 块内 `customThemePalettes = settings.customThemePalettes`（34 行）之后加：

```ts
    if (isChatFontScale(settings.chatFontScale)) {
      setChatFontScale(settings.chatFontScale)
    }
```

- [ ] **Step 6: mergeGeneralSettings 补字段**

`apps/web/src/components/settings/general-settings-state.ts` 137 行 `agentMessageAvatarMode: ...` 之后加：

```ts
    chatFontScale: updates.chatFontScale ?? base.chatFontScale ?? 'md',
```

- [ ] **Step 7: index.css 档位变量与字号 token**

(a) 现有 `@theme {` 块（14-27 行，`--radius: 0.5rem;` 之后）加语义字号 token：

```css
  --text-micro: 10px;
  --text-caption: 11px;
  --text-ui: 12px;
  --text-body: 13px;
  --text-body-lg: 14px;
```

⚠️ 命名注意：12px 档**不能**叫 `--text-secondary`——本仓库已定义 `--color-secondary`（shadcn 色板），Tailwind v4 中 `text-secondary` 会在字号/颜色两个 token namespace 间产生解析歧义。故命名 `--text-ui`（UI 次要文字档）。

(b) 现有 `@theme inline {` 块（Task 1 改后含 `--font-*`）加对话档位字号（Tailwind v4 自动生成带配对行高的 `text-chat`）：

```css
  --text-chat: var(--lume-chat-font-size);
  --text-chat--line-height: 1.85;
```

(c) `:root {` 块（564 行）开头加：

```css
  --lume-chat-font-size: 15px;
  --lume-chat-measure: 680px;
```

(d) `:root` 块之后新增档位选择器（放在 `.dark {` 之前）：

```css
:root[data-chat-font-scale='sm'] {
  --lume-chat-font-size: 14px;
}

:root[data-chat-font-scale='lg'] {
  --lume-chat-font-size: 16.5px;
}
```

- [ ] **Step 8: 验证**

```bash
cd apps/web && rtk bun run typecheck && rtk bun run test:unit
```

Expected: 全绿（本任务无组件行为变更）。

- [ ] **Step 9: Commit**

```bash
rtk git add -A && rtk git commit -m "✨ feat(web): 对话字号档位 runtime 与语义字号 token

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 对话流排版体验

**Files:**
- Modify: `apps/web/src/index.css`（`.agent-message-markdown` 系列规则）
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`（两处 renderMarkdown + 用户气泡）
- Modify: `apps/web/src/components/agent/AgentInput.tsx`（composer 对齐）

**Interfaces:**
- Consumes: `text-chat` utility、`--lume-chat-measure`、`--font-mono`（Task 1/3）

- [ ] **Step 1: index.css——标题 em 化 + letter-spacing 归零**

将 340-354 行标题规则：

```css
.agent-message-markdown h1,
.agent-message-markdown h2,
.agent-message-markdown h3,
.agent-message-markdown h4 {
  margin: 26px 0 10px;
  color: var(--lume-text-primary);
  font-weight: 700;
  letter-spacing: -0.018em;
  line-height: 1.4;
}

.agent-message-markdown h1 { font-size: 24px; }
.agent-message-markdown h2 { font-size: 21px; }
.agent-message-markdown h3 { font-size: 18px; }
.agent-message-markdown h4 { font-size: 16px; }
```

替换为：

```css
.agent-message-markdown h1,
.agent-message-markdown h2,
.agent-message-markdown h3,
.agent-message-markdown h4 {
  margin: 26px 0 10px;
  color: var(--lume-text-primary);
  font-weight: 700;
  /* CJK 负字距挤压标点，标题字距归零 */
  letter-spacing: 0;
  line-height: 1.4;
}

.agent-message-markdown h1 { font-size: 1.35em; }
.agent-message-markdown h2 { font-size: 1.17em; }
.agent-message-markdown h3 { font-size: 1.07em; }
.agent-message-markdown h4 { font-size: 1em; }
```

- [ ] **Step 2: index.css——正文 measure 限宽**

252-257 行 `.agent-message-markdown { ... }` 基础块之后新增：

```css
/* 正文段落限宽（≈45 汉字/行）；代码块/表格/图片继续撑满消息容器 */
.agent-message-markdown > p,
.agent-message-markdown ul,
.agent-message-markdown ol,
.agent-message-markdown blockquote {
  max-width: var(--lume-chat-measure);
}
```

- [ ] **Step 3: index.css——代码块字号随档位**

Task 1 改后的 `.agent-message-markdown .code-block-wrapper pre.shiki` 块（原 177-184 行）内 `font-family: var(--font-mono);` 之后加一行：

```css
  font-size: 0.8667em;
```

（= 13/15；中档下与旧值 13px 一致，档位切换自动联动。CodeBlock.tsx 内部 `text-[13px]` 不动——右面板等其他上下文保持绝对字号。）

- [ ] **Step 4: RuntimeEventContentBlock.tsx——正文与气泡换 token**

先定位（预期两处）：

```bash
rg -n "text-\[15px\] leading-7" apps/web/src/components/agent/RuntimeEventContentBlock.tsx
```

每处 `className="agent-message-markdown x-markdown text-[15px] leading-7 text-[var(--lume-text-primary)]"` 改为：

```tsx
className="agent-message-markdown x-markdown text-chat text-[var(--lume-text-primary)]"
```

用户消息气泡（594 行附近）：

```tsx
'text-[15px] font-medium leading-[22px] text-[var(--lume-text-primary)]',
```

改为：

```tsx
'text-chat font-medium leading-[1.5] text-[var(--lume-text-primary)]',
```

- [ ] **Step 5: AgentInput.tsx——composer 与消息列对齐**

893 行（editor attributes class）：

```tsx
'outline-none min-h-[72px] max-h-[220px] overflow-y-auto text-[14px] leading-7 text-[var(--text-1)]',
```

改为：

```tsx
'outline-none min-h-[72px] max-h-[220px] overflow-y-auto text-chat text-[var(--text-1)]',
```

1910 行：

```tsx
<div className="mx-auto w-full max-w-[980px] px-4">
```

改为：

```tsx
<div className="mx-auto w-full max-w-[920px] px-4">
```

- [ ] **Step 6: 验证**

```bash
cd apps/web && rtk bun run typecheck && rtk bun run test:unit
```

Expected: 全绿。重点观察 `RuntimeEventContentBlock.*.test.tsx` 与 `AgentMessages.test.ts`（断言不含字号的应零影响；若有 className 精确断言失败，按新 className 更新断言并在 commit message 注明）。

- [ ] **Step 7: Commit**

```bash
rtk git add -A && rtk git commit -m "🎨 feat(web): 对话流排版升级(measure 限宽/标题 em 化/composer 对齐)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 外观设置——对话字号三档切换

**Files:**
- Modify: `apps/web/src/components/settings/AppearanceSettings.tsx`

**Interfaces:**
- Consumes: `ChatFontScale`（@lume/shared）、`setChatFontScale`（Task 3）

- [ ] **Step 1: 常量与 handler**

(a) import 区：`AppearanceSettings.tsx` 的 `@/lib/theme-mode` import 之后加：

```tsx
import { setChatFontScale } from '@/lib/chat-font-scale'
```

`@lume/shared` type import 块内追加 `ChatFontScale`。

(b) 50-53 行 `MESSAGE_AVATAR_MODE_OPTIONS` 之后加：

```tsx
const CHAT_FONT_SCALE_OPTIONS: Array<{ value: ChatFontScale; label: string }> = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
]
```

(c) 111 行 `handleMessageAvatarModeChange` 之后加：

```tsx
  const handleChatFontScaleChange = (scale: ChatFontScale) => {
    const current = settings.chatFontScale ?? 'md'
    if (scale === current || saving) return
    setChatFontScale(scale)
    void persistSettings({ chatFontScale: scale }, '外观设置已保存')
  }
```

（先 `setChatFontScale` 再持久化：乐观立即生效，失败时 toast 提示、下次启动回落。）

- [ ] **Step 2: UI 行（"Agent 消息显示" section 顶部）**

280 行 `<h2 ...>Agent 消息显示</h2>` 之后、首个 `min-h-[48px]` 行之前插入：

```tsx
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">对话字号</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              调整消息正文与代码块字号，界面其他部分不受影响
            </div>
          </div>
          <div className="lume-segmented grid w-[220px] grid-cols-3">
            {CHAT_FONT_SCALE_OPTIONS.map((option) => (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => handleChatFontScaleChange(option.value)}
                disabled={saving}
                className={cn(
                  'lume-segmented-item disabled:opacity-60',
                  (settings.chatFontScale ?? 'md') === option.value
                    ? 'lume-segmented-item-active'
                    : '',
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
```

- [ ] **Step 3: 验证**

```bash
cd apps/web && rtk bun run typecheck && rtk bun run test:unit
```

Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
rtk git add -A && rtk git commit -m "✨ feat(web): 外观设置对话字号三档切换

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 阅读页衬线排版重设计

**Files:**
- Modify: `apps/web/src/index.css`（`:root` 加 `--reading-serif`；`.reading-note-markdown` 系列字号/行高 em 化）
- Modify: `apps/web/src/components/reading/ReadingView.tsx`（删内联 serif 定义；正文引用块换 `text-chat`）

**Interfaces:**
- Consumes: `text-chat`、`--lume-chat-font-size`（Task 3）

- [ ] **Step 1: index.css——serif 栈移入 :root 并前置 Georgia**

`:root` 块（Task 3 加的 `--lume-chat-*` 之后）加：

```css
  --reading-serif: Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', STSong, SimSun, serif;
```

- [ ] **Step 2: ReadingView.tsx——删内联定义**

90 行 `readingThemeVars` 对象里删掉这一行（其余变量保留）：

```ts
  '--reading-serif': '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", STSong, SimSun, serif',
```

- [ ] **Step 3: index.css——note markdown 相对量化**

`.reading-note-markdown` 基础块（197-203 行）：

```css
.reading-note-markdown {
  color: var(--text-1);
  font-family: var(--reading-serif);
  font-size: 12.5px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
```

改为：

```css
.reading-note-markdown {
  color: var(--text-1);
  font-family: var(--reading-serif);
  font-size: var(--lume-chat-font-size);
  line-height: 1.9;
  max-width: 600px;
  overflow-wrap: anywhere;
}
```

标题四行（228-231 行）：

```css
.reading-note-markdown h1 { font-size: 16px; }
.reading-note-markdown h2 { font-size: 15px; }
.reading-note-markdown h3 { font-size: 14px; }
.reading-note-markdown h4 { font-size: 13px; }
```

改为：

```css
.reading-note-markdown h1 { font-size: 1.3em; }
.reading-note-markdown h2 { font-size: 1.17em; }
.reading-note-markdown h3 { font-size: 1.07em; }
.reading-note-markdown h4 { font-size: 1em; }
```

行内 code（247-250 行）`font-size: 11.5px;` 改为 `font-size: 0.85em;`。

- [ ] **Step 4: ReadingView.tsx——正文引用块换档位字号**

按行号定位（改动前先 `rg -n "text-\[12.5px\]|text-\[13px\]" apps/web/src/components/reading/ReadingView.tsx` 确认，预期 4 处）：

- 592 行（书摘 blockquote）：`text-[13px] italic leading-6` → `text-chat italic leading-[1.7]`
- 915 行（笔记摘录 blockquote）：`text-[12.5px] italic leading-6` → `text-chat italic leading-[1.7]`
- 966 行（读书正文面板）：`text-[13px] leading-[1.85]` → `text-chat leading-[1.9]`
- 1276 行（评论列表）：**保留 `text-[12px]`**（次要信息，刻意小字号，不随档位）
- 583/908 行（卡片标题 `text-[16px]`/`text-[15px]`）：**保留**（卡片上下文非阅读正文）

- [ ] **Step 5: 验证**

```bash
cd apps/web && rtk bun run typecheck && rtk bun run test:unit
```

Expected: 全绿（`reading-view-state.test.ts` 不涉样式）。

- [ ] **Step 6: Commit**

```bash
rtk git add -A && rtk git commit -m "🎨 feat(web): 阅读页衬线排版重设计(档位联动/行宽/标题层级)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 规约、全量回归与交付

**Files:**
- Modify: `CLAUDE.md`（加排版规约一节）
- Modify: 无代码

**Interfaces:** 无。

- [ ] **Step 1: CLAUDE.md 排版规约**

第 5 节（改动工作流）之后追加：

```markdown
## 6. 排版规范

新代码字号使用语义 token（`text-micro` / `text-caption` / `text-ui` / `text-body` / `text-body-lg` / `text-chat`），禁止新增 `text-[Npx]` 形式的字号 utility；行高跟随 token 配对值（`text-chat` 自带 1.85）。对话流内派生字号（标题/行内 code/代码块）用 em 相对量，保证档位联动。字号 token 命名避开颜色名（如 `secondary`/`muted` 已是 `--color-*`，会产生 `text-*` 解析歧义）。存量 `text-[Npx]` 触碰时顺手迁移，不做机械全量替换。
```

- [ ] **Step 2: 全量回归**

```bash
cd apps/web && rtk bun run typecheck && rtk bun run test:unit && rtk bun run build
cd ../sidecar && rtk bun run typecheck && rtk bun run test:unit
```

Expected: 全绿；web build 产物含 `dist/fonts/MiSans-VF.woff2`。

- [ ] **Step 3: 人工验收矩阵（dev server，`cd apps/web && rtk bun run dev` 或 desktop dev）**

| 维度 | 检查点 |
|---|---|
| 字体 | 中文正文渲染为 MiSans（开发者工具 Computed 面板确认）；中英混排基线协调；标点不挤压 |
| 档位 | 设置→外观→对话字号 小/中/大：正文/气泡/composer/代码块联动缩放；侧栏/设置页/右面板不变 |
| 对话流 | 正文段落限宽 ~45 字/行；代码块/表格撑满 920px；h1-h4 层级收敛；composer 与消息列对齐同宽 |
| 阅读页 | 正文 15px/衬线/限宽；笔记随档位联动 |
| 亮暗 × 上述 | 每档位在 light/dark 各过一遍 |
| diff | pierre diff 代码字体为 JetBrains Mono（shadow DOM 继承验证） |
| 启动 | 改档→重启→档位保持（localStorage 首帧 + generalSettings 校正） |

- [ ] **Step 4: Commit 与交付**

```bash
rtk git add -A && rtk git commit -m "📝 docs: 排版 token 使用规约

Co-Authored-By: Claude <noreply@anthropic.com>"
rtk git push -u origin worktree-typography-system
```

随后创建 PR（标题：`✨ 排版体系升级：MiSans 字体/字号 token/对话流体验/档位/阅读页`），按 main 分支保护规则经 review 合并。

---

## Self-Review 记录

- **Spec 覆盖**：设计 §1（三族字体/mono 收口/Inter 删除）→ Task 1；§2.1 token → Task 3；§2.2 对话流 → Task 4；§2.3 档位机制 → Task 2/3/5；§3.1 清理 5 处 → Task 1（Inter/mono×2）、Task 6（reading-serif 移入）、Task 7（CLAUDE.md 规约）；§3.2 阅读页 → Task 6；§3.3 验证 → 各 Task + Task 7 矩阵。无缺口。
- **占位符**：无 TBD/TODO。
- **命名冲突自查**：字号 token `--text-ui` 替代原设计的 `--text-secondary`——`--color-secondary` 已存在，Tailwind v4 `text-secondary` 字号/颜色双 namespace 解析歧义。其余 token 名（micro/caption/body/body-lg/chat）无 `--color-*` 同名。
- **类型一致性**：`ChatFontScale` 三值枚举在 shared/sidecar/web 三端一致；`setChatFontScale`/`readStoredChatFontScale`/`isChatFontScale` 签名在 Task 3 定义、Task 5 消费一致；`getSettingsPath()` 无参签名已核。
