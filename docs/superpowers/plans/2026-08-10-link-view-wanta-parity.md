# Link 视图对齐 wanta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lume 连接器页面（`apps/web/src/components/link/`）的展示全面对齐 wanta `Connections` 页：布局从 Tabs 改为 Split-view 双栏，详情从弹窗改为右侧面板，品牌 logo 分层覆盖（lobehub + simple-icons）。

**Architecture:** 就地实现双栏（用 `lume-panel` + CSS Grid，不抽通用原语）；拆分 850 行单文件 `LinkView.tsx` 为 8 个聚焦组件；logo 走 `lobehub → simple-icons → iconUrl → 首字母` 四档兜底；simple-icons 走构建期生成的 `service→{path,hex}` 映射表（仅命中项，控制 bundle）。

**Tech Stack:** React 18.3.1 + TypeScript + base-ui (`@base-ui/react`) + Tailwind v4.1 + `@tanstack/react-virtual` + `@lobehub/icons` ^5.4.0 + 新增 `simple-icons` + bun:test。

## Global Constraints

- **测试运行器**：`bun:test`（非 vitest）。组件测试参考 `ProviderIcon.test.tsx` 的 fake DOM 模式。单测命令 `bun run --filter @lume/web test`（即 `bun scripts/run-unit-tests.mjs`）。
- **类型检查**：`bun run --filter @lume/web typecheck`（即 `tsc --noEmit`）。每个任务结束必须绿。
- **lobehub 深路径约束**：导入 lobehub 品牌必须走 `@lobehub/icons/es/<Icon>/components/Mono` 深路径，**禁止**从 `@lobehub/icons` 根入口导入（React 19 `use()` 兼容，见 `ProviderIcon.tsx:2-6` 注释）。
- **文案**：硬编码中文（Lume 无 i18n，跟随现状）。
- **token**：用 `--lume-*` 体系（`--lume-text-1/3`、`--lume-accent`、`--lume-accent-soft`、`--lume-focus-ring`、`--lume-success`、`--lume-warning`、`--lume-danger`），**禁止** wanta 的 `oo-*` / `--accent-ring`。
- **worktree 约束**：所有改动只在 `worktree-feat-link-view-wanta-parity` 分支；依赖已 `bun install`。
- **runs 数据层保留**：`lib/desktop-api/link.ts` 的 `listLinkRuns`/`getLinkRun` 与 `LinkRun*` 类型**不得删除**（仅移除 UI）。
- **commit 风格**：emoji 前缀 + 中文 conventional commit（如 `✨ feat(link): ...`）。
- **设计文档**：`docs/superpowers/specs/2026-08-10-link-view-wanta-parity-design.md`（已提交 d4c2826b）。

## 参考文件（实现前必读）

- 现状主文件：`apps/web/src/components/link/LinkView.tsx`（850 行，将被拆分重写）
- logo 决策：`apps/web/src/lib/provider-icon.ts`、`apps/web/src/components/link/ProviderIcon.tsx`
- 虚拟化常量：`apps/web/src/lib/provider-grid.ts`（`PROVIDER_GRID`、`computeColumnCount`、`rowCount`）
- 排序：`apps/web/src/lib/provider-ranking.ts`（`linkServicePriority`）
- base-ui wrapper 范式：`apps/web/src/components/ui/toggle.tsx`（`data-slot` + cva + `TogglePrimitive.Props`）
- IPC 入口：`apps/web/src/lib/desktop-api/index.ts`（聚合导出）
- 类型：`packages/shared/src/types/link.ts`（`LinkProviderSummary`/`LinkProviderDetail`/`LinkConnectionSummary` 等）

---

## Task 1: 品牌 logo 分层链 + simple-icons（纯逻辑，TDD）

**Files:**
- Modify: `apps/web/package.json`（加 `simple-icons` 依赖）
- Create: `apps/web/scripts/generate-link-icons.mjs`（构建期生成脚本）
- Create: `apps/web/src/lib/generated/link-icons.ts`（生成产物，提交）
- Modify: `apps/web/src/lib/provider-icon.ts`（加 simple-icons 档 + slug 归一化）
- Modify: `apps/web/src/lib/provider-icon.test.ts`（加测试）
- Modify: `apps/web/src/components/link/ProviderIcon.tsx`（渲染 simple-icons 档）
- Create: `apps/web/src/components/link/SimpleIconGlyph.tsx`

**Interfaces:**
- Produces: `decideIconKind(service, iconUrl): IconKind`（新增 `"simpleIcon"` 档，优先级 lobehub > simpleIcon > image > letter）；`serviceToSimpleSlug(service): string | null`；生成表 `LINK_ICONS: Record<string, { path: string; hex: string }>`（key 为小写 service）。
- Consumes: `simple-icons` npm 包的 slug→icon 索引；OpenConnector v1.3.3 service 列表（脚本运行时从 tarball 读取 `src/providers/*/` 目录名）。

- [ ] **Step 1: 加 simple-icons 依赖**

Run（worktree 根）:
```bash
cd apps/web && bun add simple-icons && cd ../..
```
Expected: `apps/web/package.json` 出现 `"simple-icons": "^15.x"`（以实际最新为准）。

- [ ] **Step 2: 写归一化与决策的失败测试**

追加到 `apps/web/src/lib/provider-icon.test.ts`：
```ts
import { decideIconKind, serviceToSimpleSlug } from "./provider-icon";

test("snake_case service 归一化为 kebab slug", () => {
  expect(serviceToSimpleSlug("microsoft_teams")).toBe("microsoft-teams");
  expect(serviceToSimpleSlug("google_calendar")).toBe("google-calendar");
});

test("override 表修正不一致 slug", () => {
  expect(serviceToSimpleSlug("active_campaign")).toBe("activecampaign");
});

test("decideIconKind: lobehub 优先于 simple-icons", () => {
  // github 在 lobehub 与 simple-icons 都有 → lobehub 胜
  expect(decideIconKind("github", undefined)).toBe("lobehub");
});

test("decideIconKind: 命中 simple-icons 映射返回 simpleIcon", () => {
  // slack 不在 lobehub 但在生成表 → simpleIcon
  expect(decideIconKind("slack", undefined)).toBe("simpleIcon");
});

test("decideIconKind: 无 logo 且有 iconUrl 返回 image", () => {
  expect(decideIconKind("some_unknown_service", "https://x/y.svg")).toBe("image");
});

test("decideIconKind: 兜底 letter", () => {
  expect(decideIconKind("totally_unknown_xyz", undefined)).toBe("letter");
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/web && bun run test:unit`
Expected: FAIL（`serviceToSimpleSlug` 未导出 / `"simpleIcon"` 档不存在）。

- [ ] **Step 4: 写生成脚本**

Create `apps/web/scripts/generate-link-icons.mjs`：
```js
// 构建期：读 OpenConnector v1.3.3 service 列表 + simple-icons，生成 service→{path,hex} 映射。
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import * as simpleIcons from "simple-icons";

const ARCHIVE_URL =
  "https://codeload.github.com/oomol-lab/open-connector/tar.gz/refs/tags/v1.3.3";

// service(小写)→ simple-icons slug 手工修正（不一致时填）
const SLUG_OVERRIDES = {
  active_campaign: "activecampaign",
  google_calendar: "googlecalendar",
  microsoft_teams: "microsoftteams",
};

function serviceToSlug(service) {
  if (SLUG_OVERRIDES[service]) return SLUG_OVERRIDES[service];
  return service.replaceAll("_", "-");
}

async function fetchServiceList() {
  const dir = await mkdtemp(join(tmpdir(), "openconnector-"));
  try {
    const res = await fetch(ARCHIVE_URL);
    if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const gz = gunzipSync(buf);
    await new Promise((resolve, reject) => {
      const extractor = extract();
      extractor.on("entry", async (header, stream, next) => {
        // 仅关注 providers 目录下的 definition 路径，取目录名
        const m = header.name.match(/open-connector-[^/]+\/src\/providers\/([^/]+)\/definition\.ts$/);
        if (m) {
          // 记录 service 名即可，不读内容
          stream.on("data", () => {});
          stream.on("end", next);
          const svc = m[1];
          if (!services.includes(svc)) services.push(svc);
        } else {
          stream.on("data", () => {});
          stream.on("end", next);
        }
      });
      extractor.on("finish", resolve);
      extractor.on("error", reject);
      Readable.from(gz).pipe(extractor);
    });
    return services.sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const services = [];
const map = {};
for (const service of await fetchServiceList()) {
  const slug = serviceToSlug(service);
  // simple-icons 导出形如 siSlack（驼峰）
  const exportName =
    "si" + slug.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const icon = simpleIcons[exportName];
  if (icon && icon.path) {
    map[service.toLowerCase()] = { path: icon.path, hex: icon.hex };
  }
}

const out = `// 自动生成（scripts/generate-link-icons.mjs）。勿手改。OpenConnector v1.3.3 × simple-icons。
export const LINK_ICONS: Record<string, { path: string; hex: string }> = ${JSON.stringify(
  map,
)};\n`;
await writeFile(
  new URL("../src/lib/generated/link-icons.ts", import.meta.url),
  out,
  "utf8",
);
console.log(`generated ${Object.keys(map).length} link icons`);
```
> 实现说明：`tar-stream` 需作为 devDependency；若不愿引入，可用 `tar` 包（Node 内置无）。实施时按仓库已有依赖选最轻的；若都没有，`bun add -d tar-stream`。

- [ ] **Step 5: 运行生成脚本，产出映射表**

Run: `cd apps/web && bun run scripts/generate-link-icons.mjs`
Expected: 打印 `generated N link icons`（N ≈ 400-600），`src/lib/generated/link-icons.ts` 生成。抽查含 `slack`、`stripe`、`twilio`、`dingtalk` 等条目。

- [ ] **Step 6: 扩展 provider-icon.ts**

替换 `apps/web/src/lib/provider-icon.ts` 内容：
```ts
import { LINK_ICONS } from "./generated/link-icons";

export type IconKind = "lobehub" | "simpleIcon" | "image" | "letter";

// @lobehub/icons 覆盖的 AI/开发者品牌（深路径 Mono 组件存在性验证）
export const LOBEHUB_SERVICES = [
  "github", "notion", "microsoft", "figma", "vercel",
  "openai", "anthropic", "cohere", "perplexity",
] as const;

// service(小写)→ simple-icons slug 手工修正（须与生成脚本一致）
const SLUG_OVERRIDES: Record<string, string> = {
  active_campaign: "activecampaign",
  google_calendar: "googlecalendar",
  microsoft_teams: "microsoftteams",
};

export function serviceToSimpleSlug(service: string): string | null {
  const key = service.toLowerCase();
  const slug = SLUG_OVERRIDES[key] ?? key.replaceAll("_", "-");
  return slug;
}

export function decideIconKind(service: string, iconUrl?: string): IconKind {
  const key = service.toLowerCase();
  if ((LOBEHUB_SERVICES as readonly string[]).includes(key)) return "lobehub";
  if (LINK_ICONS[key]) return "simpleIcon";
  if (iconUrl) return "image";
  return "letter";
}

export function initialOf(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

const LETTER_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#d97706", "#10b981", "#06b6d4", "#ef4444", "#6366f1"];

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd apps/web && bun run test:unit`
Expected: PASS（含新加的归一化/决策测试）。注意：Step 2 的 `slack` 测试要求生成表含 `slack`——若 simple-icons 命名导致未命中，调整 SLUG_OVERRIDES 或测试用实际命中的 service。

- [ ] **Step 8: 新建 SimpleIconGlyph 组件**

Create `apps/web/src/components/link/SimpleIconGlyph.tsx`：
```tsx
// 渲染 simple-icons 的 SVG path（brand 单色路径，默认跟随 currentColor）
export function SimpleIconGlyph({ path, size }: { path: string; size: number }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      style={{ fill: "currentColor" }}
    >
      <path d={path} />
    </svg>
  );
}
```

- [ ] **Step 9: ProviderIcon 接入 simple-icons 档**

在 `apps/web/src/components/link/ProviderIcon.tsx` 的 `ProviderIcon` 函数里，lobehub 分支之后、image 分支之前插入：
```tsx
  if (kind === "simpleIcon") {
    const icon = LINK_ICONS[service.toLowerCase()];
    if (icon) {
      return (
        <span className="shrink-0 text-[var(--lume-text-2)]" style={{ width: size, height: size }}>
          <SimpleIconGlyph path={icon.path} size={size} />
        </span>
      );
    }
  }
```
并在文件顶部加 import：
```tsx
import { LINK_ICONS } from "@/lib/generated/link-icons";
import { SimpleIconGlyph } from "./SimpleIconGlyph";
```

- [ ] **Step 10: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/package.json apps/web/scripts/generate-link-icons.mjs \
  apps/web/src/lib/generated/link-icons.ts apps/web/src/lib/provider-icon.ts \
  apps/web/src/lib/provider-icon.test.ts apps/web/src/components/link/ProviderIcon.tsx \
  apps/web/src/components/link/SimpleIconGlyph.tsx
git commit -m "✨ feat(link): 品牌 logo 分层链(lobehub+simple-icons 四档兜底)"
```

---

## Task 2: UI 基础原语 ToggleGroup + SearchField

**Files:**
- Create: `apps/web/src/components/ui/toggle-group.tsx`
- Create: `apps/web/src/components/ui/search-field.tsx`

**Interfaces:**
- Produces: `ToggleGroup`（props: `{ value: string; onValueChange: (v: string) => void; children }`，基于 `@base-ui/react/toggle-group` 单选）；`ToggleGroupItem`（props: `{ value: string; children }`）；`SearchField`（props: 继承 `Input`，加 `value`/`onValueChange`）。
- Consumes: `@base-ui/react/toggle-group`、`@/components/ui/input`、`lucide-react` 的 `Search`、`cn`。

- [ ] **Step 1: 写 ToggleGroup**

Create `apps/web/src/components/ui/toggle-group.tsx`：
```tsx
"use client";
import { ToggleGroup as ToggleGroupPrimitive, ToggleGroupItem as ToggleGroupItemPrimitive } from "@base-ui/react/toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const itemVariants = cva(
  "inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1 text-xs font-medium text-[var(--lume-text-3)] transition-colors hover:bg-muted hover:text-foreground data-[state=on]:!border-[var(--lume-focus-ring)] data-[state=on]:!bg-[var(--lume-accent-soft)] data-[state=on]:!text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
);

function ToggleGroup({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupPrimitive
      value={value}
      onValueChange={(v) => v && onValueChange(v)}
      className={cn("inline-flex flex-wrap items-center gap-1", className)}
    >
      {children}
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupItemPrimitive value={value} className={cn(itemVariants(), className)}>
      {children}
    </ToggleGroupItemPrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
```
> 若 `@base-ui/react/toggle-group` 的导出名/单选 API 与上述不符，实施时核对 `node_modules/@base-ui/react/toggle-group/` 实际类型调整（base-ui 单选用 `ToggleGroup` + items 的 `pressed`/`value`，不同版本签名略异）。

- [ ] **Step 2: 写 SearchField**

Create `apps/web/src/components/ui/search-field.tsx`：
```tsx
"use client";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type SearchFieldProps = React.InputHTMLAttributes<HTMLInputElement>;

export function SearchField({ className, ...props }: SearchFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--lume-text-3)]" />
      <Input className="pl-8" {...props} />
    </div>
  );
}
```

- [ ] **Step 3: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿（若 base-ui toggle-group 签名不符，按 Step 1 注释核对修正）。
```bash
git add apps/web/src/components/ui/toggle-group.tsx apps/web/src/components/ui/search-field.tsx
git commit -m "✨ feat(ui): ToggleGroup 与 SearchField 原语"
```

---

## Task 3: ProviderCard 重写（紧凑列表行 + 状态点 + 选中态）

**Files:**
- Modify: `apps/web/src/components/link/ProviderCard.tsx`（整体重写）
- Modify: `apps/web/src/lib/provider-grid.ts`（`cardHeight` 128→68）

**Interfaces:**
- Produces: `ProviderCard({ provider, configured, needsAttention, selected, onOpen })`。
- Consumes: `ProviderIcon`（Task 1）、`Badge`、`cn`、`LinkProviderSummary`。
- 下游：`LinkCatalog`（Task 5）以 `<button>` 形式渲染，固定 68px 高。

- [ ] **Step 1: 调整卡片高度常量**

在 `apps/web/src/lib/provider-grid.ts` 把 `cardHeight: 128` 改为 `cardHeight: 68`（对齐 wanta 68px 紧凑行）。

- [ ] **Step 2: 重写 ProviderCard**

整体替换 `apps/web/src/components/link/ProviderCard.tsx`：
```tsx
import type { LinkProviderSummary } from "@lume/shared";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderCardProps {
  provider: LinkProviderSummary;
  configured: boolean;
  needsAttention?: boolean;
  selected?: boolean;
  onOpen: (service: string) => void;
}

export function ProviderCard({ provider, configured, needsAttention, selected, onOpen }: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(provider.service)}
      className={cn(
        "group/card relative grid w-full cursor-pointer overflow-hidden rounded-md border bg-card px-2.5 py-1.5 text-left transition-colors",
        "hover:border-[var(--lume-focus-ring)] hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/40",
        selected && "border-[var(--lume-focus-ring)] bg-[var(--lume-accent-soft)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-[var(--lume-accent)]",
      )}
    >
      <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={20} />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium text-[var(--lume-text-1)]">{provider.displayName}</span>
          <span className="truncate text-[11px] text-[var(--lume-text-3)]">{provider.description || provider.service}</span>
        </span>
        <StatusMark configured={configured} needsAttention={needsAttention} />
      </span>
    </button>
  );
}

function StatusMark({ configured, needsAttention }: { configured: boolean; needsAttention?: boolean }) {
  if (!configured && !needsAttention) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span
        className={cn(
          "size-2 rounded-full",
          configured && "bg-[var(--lume-success)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--lume-success)_18%,transparent)]",
          needsAttention && "bg-[var(--lume-warning)]",
        )}
      />
    </span>
  );
}
```

- [ ] **Step 3: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿（`Badge` 不再用于卡片分类标签——若其他处未引用则不必动）。
```bash
git add apps/web/src/components/link/ProviderCard.tsx apps/web/src/lib/provider-grid.ts
git commit -m "💄 refactor(link): ProviderCard 紧凑行+状态光晕点+选中态"
```

---

## Task 4: LinkToolbar（搜索 + 筛选 ToggleGroup）

**Files:**
- Create: `apps/web/src/components/link/LinkToolbar.tsx`

**Interfaces:**
- Produces: `LinkToolbar({ query, onQueryChange, filter, onFilterChange, categories, counts })`，`filter` 类型 `LinkFilter`（见下）。
- Consumes: `SearchField`、`ToggleGroup`/`ToggleGroupItem`（Task 2）、`Badge`。
- `counts`: `{ all: number; connected: number; noSetup: number; needsAttention: number }`。

- [ ] **Step 1: 定义 filter 类型与组件**

Create `apps/web/src/components/link/LinkToolbar.tsx`：
```tsx
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type LinkFilter = "all" | "connected" | "noSetup" | "needsAttention";

export interface FilterCounts {
  all: number;
  connected: number;
  noSetup: number;
  needsAttention: number;
}

interface LinkToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  filter: LinkFilter;
  onFilterChange: (value: LinkFilter) => void;
  counts: FilterCounts;
}

export function LinkToolbar({ query, onQueryChange, filter, onFilterChange, counts }: LinkToolbarProps) {
  const items: Array<{ value: LinkFilter; label: string; count: number }> = [
    { value: "all", label: "全部", count: counts.all },
    { value: "connected", label: "已连接", count: counts.connected },
    { value: "noSetup", label: "免配置", count: counts.noSetup },
    { value: "needsAttention", label: "需处理", count: counts.needsAttention },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField
        className="max-w-xs"
        placeholder="搜索连接器…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <ToggleGroup value={filter} onValueChange={(v) => onFilterChange(v as LinkFilter)}>
        {items.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
            <span className="tabular-nums text-[var(--lume-text-3)]">{item.count}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
```

> 说明：分类（category）筛选 wanta 用动态溢出菜单。本任务先实现核心四档 + 搜索；动态分类溢出作为可选增强，放入 follow-up（避免过度设计，符合 YAGNI）。`categories` prop 暂不接收。

- [ ] **Step 2: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/src/components/link/LinkToolbar.tsx
git commit -m "✨ feat(link): LinkToolbar 搜索+筛选 ToggleGroup"
```

---

## Task 5: LinkCatalog（左栏：工具栏 + 虚拟化网格）

**Files:**
- Create: `apps/web/src/components/link/LinkCatalog.tsx`

**Interfaces:**
- Produces: `LinkCatalog({ providers, connections, query, onQueryChange, filter, onFilterChange, selectedService, onOpen })`。
- Consumes: `LinkToolbar`（Task 4）、`ProviderCard`（Task 3）、`useVirtualizer`、`computeColumnCount`/`rowCount`/`PROVIDER_GRID`、`linkServicePriority`、`LinkProviderSummary`/`LinkConnectionSummary`。

- [ ] **Step 1: 写 LinkCatalog（迁出现有虚拟化逻辑）**

Create `apps/web/src/components/link/LinkCatalog.tsx`：
```tsx
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeColumnCount, PROVIDER_GRID, rowCount } from "@/lib/provider-grid";
import { linkServicePriority } from "@/lib/provider-ranking";
import type { LinkConnectionSummary, LinkProviderSummary } from "@lume/shared";
import { LinkToolbar, type FilterCounts, type LinkFilter } from "./LinkToolbar";
import { ProviderCard } from "./ProviderCard";

interface LinkCatalogProps {
  providers: LinkProviderSummary[];
  connections: LinkConnectionSummary[];
  query: string;
  onQueryChange: (v: string) => void;
  filter: LinkFilter;
  onFilterChange: (v: LinkFilter) => void;
  selectedService: string | null;
  onOpen: (service: string) => void;
}

function providerStatus(provider: LinkProviderSummary, configuredServices: Set<string>, authTypes: string[]) {
  const configured = configuredServices.has(provider.service);
  const noSetup = authTypes.includes("no_auth");
  return { configured, noSetup, needsAttention: false };
}

export function LinkCatalog({
  providers, connections, query, onQueryChange, filter, onFilterChange, selectedService, onOpen,
}: LinkCatalogProps) {
  const configuredServices = useMemo(
    () => new Set(connections.filter((c) => c.configured).map((c) => c.service)),
    [connections],
  );

  const annotated = useMemo(
    () =>
      providers.map((p) => ({
        provider: p,
        status: providerStatus(p, configuredServices, p.authTypes ?? []),
      })),
    [providers, configuredServices],
  );

  const counts: FilterCounts = useMemo(
    () => ({
      all: annotated.length,
      connected: annotated.filter((a) => a.status.configured).length,
      noSetup: annotated.filter((a) => a.status.noSetup).length,
      needsAttention: annotated.filter((a) => a.status.needsAttention).length,
    }),
    [annotated],
  );

  const visible = useMemo(() => {
    return annotated
      .filter(({ provider, status }) => {
        const matchesQuery =
          !query ||
          `${provider.displayName} ${provider.service} ${provider.description ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase());
        const matchesFilter =
          filter === "all" ||
          (filter === "connected" && status.configured) ||
          (filter === "noSetup" && status.noSetup) ||
          (filter === "needsAttention" && status.needsAttention);
        return matchesQuery && matchesFilter;
      })
      .sort((a, b) => {
        const configuredRank = Number(b.status.configured) - Number(a.status.configured);
        if (configuredRank !== 0) return configuredRank;
        const priority = linkServicePriority(a.provider.service) - linkServicePriority(b.provider.service);
        if (priority !== 0) return priority;
        return a.provider.displayName.localeCompare(b.provider.displayName);
      });
  }, [annotated, query, filter]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setContainerWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const columns = computeColumnCount(containerWidth);
  const rows = rowCount(visible.length, columns);
  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => PROVIDER_GRID.cardHeight + PROVIDER_GRID.gap,
    overscan: PROVIDER_GRID.overscanRows,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--lume-border-subtle)] px-3 py-2">
        <LinkToolbar
          query={query}
          onQueryChange={onQueryChange}
          filter={filter}
          onFilterChange={onFilterChange}
          counts={counts}
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <div className="grid gap-1 rounded-lg border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-3">
            <div className="text-sm font-medium text-[var(--lume-text-1)]">无匹配连接器</div>
            <div className="text-xs text-[var(--lume-text-3)]">尝试更换关键词或清除筛选。</div>
          </div>
        ) : (
          <div ref={gridRef} className="relative" style={{ height: rows ? rowVirtualizer.getTotalSize() : 0 }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => (
              <div
                key={vRow.key}
                className="absolute left-0 top-0 grid gap-3"
                style={{
                  transform: `translateY(${vRow.start}px)`,
                  width: "100%",
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {Array.from({ length: columns }).map((_, col) => {
                  const entry = visible[vRow.index * columns + col];
                  if (!entry) return null;
                  return (
                    <ProviderCard
                      key={entry.provider.service}
                      provider={entry.provider}
                      configured={entry.status.configured}
                      needsAttention={entry.status.needsAttention}
                      selected={entry.provider.service === selectedService}
                      onOpen={onOpen}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/src/components/link/LinkCatalog.tsx
git commit -m "✨ feat(link): LinkCatalog 左栏(工具栏+虚拟化网格)"
```

---

## Task 6: LinkConnectDialog（凭据/OAuth 表单，从 ProviderDialog 抽出）

**Files:**
- Create: `apps/web/src/components/link/LinkConnectDialog.tsx`
- Create: `apps/web/src/components/link/secret-field.tsx`（抽出 SecretField）
- Create: `apps/web/src/lib/link-auth.ts`（抽出 `credentialFields`/`authLabel`）

**Interfaces:**
- Produces: `LinkConnectDialog({ open, provider, initialConnectionName, oauthConfig, onClose, onSaved, onReconnect, onRequestDelete })`；`SecretField`；`credentialFields(auth)`、`authLabel(type)`。
- Consumes: `Dialog*`、`Input`/`Label`/`Select*`/`Textarea`、`Button`、`ProviderIcon`、IPC（`upsertLinkConnection`/`saveLinkOAuthConfig`/`startLinkOAuth`/`getLinkOAuthStatus`/`cancelLinkOAuth`/`openExternal`/`listLinkOAuthSessions`）。
- OAuth 轮询逻辑（`setInterval(1500)`）从原 ProviderDialog 原样迁入。

- [ ] **Step 1: 抽出纯逻辑到 link-auth.ts**

Create `apps/web/src/lib/link-auth.ts`（从 `LinkView.tsx:742-771` 迁出 `credentialFields` + `authLabel`，签名不变）：
```ts
import type { LinkCredentialField } from "@lume/shared";

export function credentialFields(auth: Record<string, unknown>): LinkCredentialField[] {
  const configured = auth.type === "api_key"
    ? [
        {
          key: "apiKey",
          label: typeof auth.label === "string" ? auth.label : "API Key",
          inputType: "password" as const,
          required: true,
          secret: true,
          ...(typeof auth.placeholder === "string" ? { placeholder: auth.placeholder } : {}),
          ...(typeof auth.description === "string" ? { description: auth.description } : {}),
        },
        ...(Array.isArray(auth.extraFields) ? auth.extraFields : []),
      ]
    : auth.fields;
  return Array.isArray(configured)
    ? configured.filter((item): item is LinkCredentialField =>
        Boolean(item && typeof item === "object" && typeof (item as LinkCredentialField).key === "string"),
      )
    : [];
}

export function authLabel(type: string): string {
  return ({ no_auth: "无需认证", api_key: "API Key", custom_credential: "自定义凭据", oauth2: "OAuth 2.0" } as Record<string, string>)[type] ?? type;
}
```

- [ ] **Step 2: 抽出 SecretField**

Create `apps/web/src/components/link/secret-field.tsx`（从 `LinkView.tsx:772-803` 迁出，签名不变）：
```tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SecretField({
  label, value, onChange, secret, textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret: boolean;
  textarea?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {textarea ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input type={secret ? "password" : "text"} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: 写 LinkConnectDialog（迁入原 ProviderDialog 的表单 + OAuth 轮询）**

Create `apps/web/src/components/link/LinkConnectDialog.tsx`。整体结构 = 原 `LinkView.tsx:465-741` 的 `ProviderDialog`，做两处改动：
1. 顶部 import 换为从新位置引入（`SecretField` 从 `./secret-field`，`credentialFields`/`authLabel` 从 `@/lib/link-auth`，IPC 从 `@/lib/desktop-api`，`ProviderIcon` 从 `./ProviderIcon`）。
2. 函数名 `ProviderDialog` → `LinkConnectDialog`，props 不变。

完整代码（迁移自原 ProviderDialog，仅改 import 与函数名；保留 `save`/OAuth 轮询/`credentialFields`/actions 列表逻辑）：
```tsx
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  LinkConnectionSummary, LinkCredentialField, LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail,
} from "@lume/shared";
import {
  cancelLinkOAuth, getLinkOAuthStatus, listLinkOAuthSessions, openExternal,
  saveLinkOAuthConfig, startLinkOAuth, upsertLinkConnection,
} from "@/lib/desktop-api";
import { authLabel, credentialFields } from "@/lib/link-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProviderIcon } from "./ProviderIcon";
import { SecretField } from "./secret-field";

// 函数体与原 ProviderDialog (LinkView.tsx:465-741) 完全一致，仅改名 + import 来源。
// 保留：connectionName/authIndex/values/oauth/actionDetail/busy state；
//      OAuth 1500ms 轮询 getLinkOAuthStatus → authorized 调 onSaved；
//      save() 区分 oauth2(走 saveLinkOAuthConfig+startLinkOAuth+openExternal) 与凭据(upsertLinkConnection)；
//      actions 列表（getLinkAction 详情预览）原样保留。
// （为避免重复粘贴 280 行，实现时从 git 历史的原 ProviderDialog 原样复制函数体到此处，
//   仅替换 import 块与函数名。）
export function LinkConnectDialog(props: {
  provider: LinkProviderDetail | null;
  initialConnectionName: string;
  oauthConfig?: LinkOAuthConfigSummary;
  connections: LinkConnectionSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}) {
  // …原 ProviderDialog 函数体…
}
```
> 实现注记：本步是机械迁移。从 `git show HEAD~N:apps/web/src/components/link/LinkView.tsx`（或当前未删除的副本）复制原 `ProviderDialog` 函数体（state、两个 useEffect、save、return JSX），粘贴为新文件函数体，替换 import。**禁止改动业务逻辑**（保 OAuth 轮询不变量）。

- [ ] **Step 4: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿（此时 `LinkConnectDialog` 尚未被引用，但不影响 typecheck）。
```bash
git add apps/web/src/lib/link-auth.ts apps/web/src/components/link/secret-field.tsx \
  apps/web/src/components/link/LinkConnectDialog.tsx
git commit -m "♻️ refactor(link): 抽出 LinkConnectDialog/SecretField/link-auth"
```

---

## Task 7: LinkAccountsList（已连接账户卡片）

**Files:**
- Create: `apps/web/src/components/link/LinkAccountsList.tsx`

**Interfaces:**
- Produces: `LinkAccountsList({ connections, onReconnect, onRequestDelete })`。
- Consumes: `Badge`、`Button`、`LinkConnectionSummary`。

- [ ] **Step 1: 写组件**

Create `apps/web/src/components/link/LinkAccountsList.tsx`：
```tsx
import type { LinkConnectionSummary } from "@lume/shared";
import { authLabel } from "@/lib/link-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LinkAccountsListProps {
  connections: LinkConnectionSummary[];
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}

export function LinkAccountsList({ connections, onReconnect, onRequestDelete }: LinkAccountsListProps) {
  if (connections.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--lume-text-1)]">已连接账户（{connections.length}）</div>
      <div className="space-y-1.5">
        {connections.map((conn) => (
          <div key={conn.connectionName} className="flex items-center justify-between gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-card px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-[var(--lume-text-1)]">{conn.connectionName}</span>
                {conn.default && <Badge variant="secondary">默认</Badge>}
              </div>
              <div className="truncate text-xs text-[var(--lume-text-3)]">
                {conn.profile?.displayName || conn.profile?.accountId || authLabel(conn.authType)}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="outline" size="sm" onClick={() => onReconnect(conn.connectionName)}>重连</Button>
              <Button variant="ghost" size="sm" className="text-[var(--lume-danger)]" onClick={() => onRequestDelete(conn.connectionName)}>断开</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/src/components/link/LinkAccountsList.tsx
git commit -m "✨ feat(link): LinkAccountsList 账户卡片"
```

---

## Task 8: LinkDetailPane（右栏：头部 + 连接操作 + 账户 + 详情 dl）

**Files:**
- Create: `apps/web/src/components/link/LinkDetailPane.tsx`

**Interfaces:**
- Produces: `LinkDetailPane({ provider, connections, oauthConfig, onConnect, onClose, onReconnect, onRequestDelete })`。
- Consumes: `ProviderIcon`（Task 1）、`LinkAccountsList`（Task 7）、`Badge`/`Button`、`LinkProviderDetail`/`LinkConnectionSummary`/`LinkOAuthConfigSummary`。
- `onConnect(service)` → 由父组件打开 `LinkConnectDialog`。

- [ ] **Step 1: 写组件**

Create `apps/web/src/components/link/LinkDetailPane.tsx`：
```tsx
import type { LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderDetail } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { authLabel } from "@/lib/link-auth";
import { ProviderIcon } from "./ProviderIcon";
import { LinkAccountsList } from "./LinkAccountsList";

interface LinkDetailPaneProps {
  provider: LinkProviderDetail;
  connections: LinkConnectionSummary[];
  oauthConfig?: LinkOAuthConfigSummary;
  onConnect: (service: string) => void;
  onClose: () => void;
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}

export function LinkDetailPane({ provider, connections, oauthConfig, onConnect, onClose, onReconnect, onRequestDelete }: LinkDetailPaneProps) {
  const configured = connections.some((c) => c.configured);
  const authTypes = provider.authTypes?.length ? provider.authTypes : provider.auth?.map((a) => String(a.type)) ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* 头部 */}
      <div className="flex items-start justify-between gap-3 border-b border-[var(--lume-border-subtle)] p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={36} />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--lume-text-1)]">{provider.displayName}</h2>
            <p className="mt-0.5 text-xs text-[var(--lume-text-3)]">{provider.description || provider.service}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
      </div>
      {/* 连接操作 */}
      <div className="grid gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[var(--lume-text-1)]">{configured ? "已连接" : "未连接"}</span>
          <Button size="sm" onClick={() => onConnect(provider.service)}>{configured ? "添加连接" : "连接"}</Button>
        </div>
        {authTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {authTypes.map((t) => <Badge key={t} variant="secondary">{authLabel(t)}</Badge>)}
          </div>
        )}
        <LinkAccountsList connections={connections} onReconnect={onReconnect} onRequestDelete={onRequestDelete} />
        {/* 详情 dl */}
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 border-t border-[var(--lume-border-subtle)] pt-3 text-xs">
          <dt className="text-[var(--lume-text-3)]">服务</dt>
          <dd className="truncate font-mono text-[var(--lume-text-2)]">{provider.service}</dd>
          {provider.categories?.length ? (
            <>
              <dt className="text-[var(--lume-text-3)]">分类</dt>
              <dd className="truncate text-[var(--lume-text-2)]">{provider.categories.join("、")}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/src/components/link/LinkDetailPane.tsx
git commit -m "✨ feat(link): LinkDetailPane 右栏详情面板"
```

---

## Task 9: LinkView 重写为 Split-view（集成 + 移除 runs UI）

**Files:**
- Modify: `apps/web/src/components/link/LinkView.tsx`（整体重写为 shell）
- Delete: 内联的 `ProviderDialog`/`credentialFields`/`authLabel`/`SecretField`/`Filter`/`DetailPreview`/`Empty`（已迁出或不再需要）

**Interfaces:**
- Consumes: `LinkCatalog`（Task 5）、`LinkDetailPane`（Task 8）、`LinkConnectDialog`（Task 6）、`Badge`/`Button`/`ConfirmDialog`、IPC（`getLinkProvider`/`getLinkRuntimeState`/`listLinkProviders`/`listLinkConnections`/`listLinkOAuthConfigs`/`deleteLinkConnection` + 事件订阅）、`linkProviderTargetAtom`。
- **保留不变量**：`refresh()`、`onLinkRuntimeState`/`onLinkDataChanged` 订阅、`linkProviderTargetAtom` 跨页打开、`deleteTarget` + ConfirmDialog。
- **移除**：`runs`/`runCursor`/`runService`/`runOutcome`/`runBusy`/`runDetail` state；运行记录 Tab；run-detail Dialog；`listLinkRuns`/`getLinkRun` 在 refresh 中的调用（**但保留 IPC 函数本身不删**）。

- [ ] **Step 1: 重写 LinkView 为双栏 shell**

整体替换 `apps/web/src/components/link/LinkView.tsx`：
```tsx
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAtom } from "jotai";
import type {
  LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderDetail, LinkProviderSummary,
} from "@lume/shared";
import { linkProviderTargetAtom } from "@/atoms";
import {
  deleteLinkConnection, getLinkProvider, getLinkRuntimeState, listLinkConnections,
  listLinkOAuthConfigs, listLinkProviders, onLinkDataChanged, onLinkRuntimeState,
} from "@/lib/desktop-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LinkCatalog } from "./LinkCatalog";
import { LinkDetailPane } from "./LinkDetailPane";
import { LinkConnectDialog } from "./LinkConnectDialog";
import type { LinkFilter } from "./LinkToolbar";

export function LinkView() {
  const [providers, setProviders] = useState<LinkProviderSummary[]>([]);
  const [connections, setConnections] = useState<LinkConnectionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LinkFilter>("all");
  const [selected, setSelected] = useState<LinkProviderDetail | null>(null);
  // selected 控制右侧详情面板；connectOpen 独立控制凭据/OAuth 弹窗（点"连接"才开，与面板解耦）
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedConnectionName, setSelectedConnectionName] = useState("default");
  const [online, setOnline] = useState(false);
  const [oauthConfigs, setOAuthConfigs] = useState<LinkOAuthConfigSummary[]>([]);
  const [providerTarget, setProviderTarget] = useAtom(linkProviderTargetAtom);
  const [deleteTarget, setDeleteTarget] = useState<LinkConnectionSummary | null>(null);

  const refresh = useCallback(async () => {
    const runtime = await getLinkRuntimeState();
    setOnline(runtime.phase === "online");
    if (runtime.phase !== "online") {
      setProviders([]); setConnections([]); setOAuthConfigs([]); return;
    }
    const [nextProviders, nextConnections, nextOAuthConfigs] = await Promise.all([
      listLinkProviders(), listLinkConnections(), listLinkOAuthConfigs(),
    ]);
    setProviders(nextProviders);
    setConnections(nextConnections);
    setOAuthConfigs(nextOAuthConfigs);
  }, []);

  useEffect(() => {
    void refresh().catch(() => toast.error("无法读取连接器数据"));
    let offRuntime: (() => void) | undefined;
    let offData: (() => void) | undefined;
    void onLinkRuntimeState(() => void refresh()).then((off) => { offRuntime = off; });
    void onLinkDataChanged(() => void refresh()).then((off) => { offData = off; });
    return () => { offRuntime?.(); offData?.(); };
  }, [refresh]);

  useEffect(() => {
    if (!online || !providerTarget) return;
    void getLinkProvider(providerTarget)
      .then((provider) => { setSelectedConnectionName("default"); setSelected(provider); setProviderTarget(null); })
      .catch(() => toast.error("无法打开连接器详情"));
  }, [online, providerTarget, setProviderTarget]);

  const openProvider = (service: string) => {
    void getLinkProvider(service)
      .then((detail) => { setSelectedConnectionName("default"); setSelected(detail); })
      .catch(() => toast.error("无法打开连接器详情"));
  };

  if (!online) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Badge variant="secondary">未启用</Badge>
        <h1 className="text-xl font-semibold">连接器</h1>
        <p className="max-w-sm text-sm text-[var(--lume-text-3)]">
          连接器需要本机 OpenConnector Link 运行时。请在「设置 → Link 运行时」中启用。
        </p>
        <Button variant="outline" onClick={() => window.dispatchEvent(new CustomEvent("lume:open-settings"))}>
          打开 Link 运行时设置
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-6 pt-6">
        <div>
          <h1 className="text-xl font-semibold">连接器</h1>
          <p className="mt-1 text-sm text-[var(--lume-text-3)]">由本机 OpenConnector Link 提供，连接凭据不会进入渲染器。</p>
        </div>
        <Badge variant={online ? "default" : "secondary"}>{online ? "本地运行中" : "未启用"}</Badge>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] px-6 pb-6 transition-[grid-template-columns] duration-200 ease-out"
           style={selected ? { gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)" } : undefined}>
        <div className="min-h-0 overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-card">
          <LinkCatalog
            providers={providers}
            connections={connections}
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            selectedService={selected?.service ?? null}
            onOpen={openProvider}
          />
        </div>
        {selected && (
          <div className="min-h-0 overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-card animate-in fade-in-0 slide-in-from-right-2">
            <LinkDetailPane
              provider={selected}
              connections={connections.filter((c) => c.service === selected.service)}
              oauthConfig={oauthConfigs.find((o) => o.service === selected.service)}
              onConnect={() => setConnectOpen(true)}
              onClose={() => setSelected(null)}
              onReconnect={(name) => { setSelectedConnectionName(name); setConnectOpen(true); }}
              onRequestDelete={(name) => {
                const target = connections.find((c) => c.service === selected.service && c.connectionName === name);
                if (target) setDeleteTarget(target);
              }}
            />
          </div>
        )}
      </div>
      {selected && connectOpen && (
        <LinkConnectDialog
          provider={selected}
          initialConnectionName={selectedConnectionName}
          oauthConfig={oauthConfigs.find((o) => o.service === selected.service)}
          connections={connections.filter((c) => c.service === selected.service)}
          onClose={() => setConnectOpen(false)}
          onSaved={async () => { await refresh(); setConnectOpen(false); }}
          onReconnect={(name) => setSelectedConnectionName(name)}
          onRequestDelete={(name) => {
            const target = connections.find((c) => c.service === selected.service && c.connectionName === name);
            if (target) setDeleteTarget(target);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="断开这个连接？"
        description={deleteTarget ? `将删除 ${deleteTarget.service} 的 ${deleteTarget.connectionName} 本地凭据。` : ""}
        confirmLabel="断开连接"
        destructive
        onConfirm={() => {
          if (!deleteTarget) return;
          void deleteLinkConnection(deleteTarget.service, deleteTarget.connectionName)
            .then(() => refresh())
            .catch((error) => toast.error(error instanceof Error ? error.message : "断开失败"))
            .finally(() => setDeleteTarget(null));
        }}
      />
    </div>
  );
}
```
> 注 1：详情面板与凭据弹窗解耦——`selected` 控制右侧面板（点 provider 即开），`connectOpen` 独立控制 `LinkConnectDialog` 弹窗（点"连接/重连"才开）。这修正了原稿让 `selected` 同时驱动二者的重叠 bug（对齐 wanta：选中→面板，点连接→弹窗）。
> 注 2：placeholder 的"打开设置"用 `CustomEvent("lume:open-settings")`，若 Lume 已有跳设置的标准入口（如 atom 或 props），实施时替换为真实入口（grep `openSettings`/`setRoute` 确认）。

- [ ] **Step 2: 删除已迁出的内联辅助函数**

从 `LinkView.tsx` 删除：`ProviderDialog`、`credentialFields`、`authLabel`、`SecretField`、`Filter`、`DetailPreview`、`Empty`（均已迁出 Task 6/7 或不再需要）。删除不再用的 import（`Tabs*`、`CheckCircle2`/`XCircle`、`formatDurationLabel`、`formatDateTime`、`previewValue`、`listLinkRuns`/`getLinkRun` 等）。

- [ ] **Step 3: 确认 runs IPC 函数仍在但 UI 已无引用**

Run: `grep -rn "listLinkRuns\|getLinkRun" apps/web/src`
Expected: 仅命中 `lib/desktop-api/link.ts`（定义）与可能的 `lib/desktop-api/index.ts`（聚合导出）；**无** `LinkView.tsx` 引用。类型 `LinkRunSummary`/`LinkRunDetail`/`LinkRunPage` 保留不动。

- [ ] **Step 4: typecheck + 单测 + 提交**

Run: `cd apps/web && bun run typecheck && bun run test:unit`
Expected: typecheck 绿；单测全绿（含 Task 1 的 logo 测试 + 原有 ProviderIcon.test.tsx）。
```bash
git add apps/web/src/components/link/LinkView.tsx
git commit -m "♻️ refactor(link): LinkView 重写为 Split-view 双栏(移除运行记录 UI,保留数据层)"
```

---

## Task 10: 导航图标 PlugZap → Plug

**Files:**
- Modify: `apps/web/src/components/app-shell/LumeSidebar.tsx:17`（import）、`:367-368`（renderIcon case）

**Interfaces:** 无（纯图标替换）。

- [ ] **Step 1: 替换 import 与 case**

`apps/web/src/components/app-shell/LumeSidebar.tsx`：
- 第 17 行 `PlugZap,` → `Plug,`
- 第 367-368 行：
```tsx
    case 'plug':
      return <Plug size={size} />
```

- [ ] **Step 2: 确认无其它 PlugZap 引用**

Run: `grep -rn "PlugZap" apps/web/src`
Expected: 仅可能命中 `settings-view-state.ts:57`（Link 运行时设置项图标）。若 wanta 也用 Plug 表示 link，则一并改 `settings-view-state.ts` 的 PlugZap → Plug（保持一致）；若希望设置项区分，可保留 PlugZap。**默认**：一并改为 Plug（与 wanta 导航一致）。

- [ ] **Step 3: typecheck + 提交**

Run: `cd apps/web && bun run typecheck`
Expected: 绿。
```bash
git add apps/web/src/components/app-shell/LumeSidebar.tsx apps/web/src/components/settings/settings-view-state.ts
git commit -m "💄 refactor(link): 导航图标 PlugZap → Plug 对齐 wanta"
```

---

## Task 11: 视觉对照验收 + 收尾

**Files:** 无代码改动（验收 + 可选微调）。

- [ ] **Step 1: 启动 dev，对照 wanta 截图验收**

Run（worktree 根）: `cd apps/desktop && bun run dev`（或项目既定启动方式）
对照 wanta `Connections` 页检查：
1. 左栏目录：紧凑卡片行（68px）+ 状态光晕点（绿=已连接）+ 选中左装饰条 + accent-soft 底色。
2. 工具栏：搜索 + 四档筛选 ToggleGroup + 计数。
3. 右栏详情：点 provider 滑入；头部 icon+标题+描述；连接按钮；账户列表；详情 dl。
4. 品牌 logo：github/openai(lobehub)、slack/stripe/simple-icons、其余首字母。
5. 导航侧栏 Plug 图标。

- [ ] **Step 2: 修复验收发现的偏差（如有）**

针对偏差做最小调整（token 颜色、间距、动画时长）。每处改完跑 `bun run --filter @lume/web typecheck`。

- [ ] **Step 3: 全量 typecheck + test**

Run: `bun run --filter @lume/web typecheck && bun run --filter @lume/web test`
Expected: 全绿。

- [ ] **Step 4: 更新记忆 + PR 准备**

- 写/更新 memory `project_lume-link-view-wanta-parity.md`（记录：Split-view 重构 + logo 分层链 + simple-icons 构建期映射 + runs UI 移除/数据层保留 + 导航 Plug）。
- 准备 PR（标题/描述对照设计文档）；按项目规则走 PR 合并 main（不本地 merge）。

---

## Self-Review

**1. Spec coverage:**
- 布局 Split-view（D1）→ Task 9 ✓
- 运行记录移除 UI 保数据层（D2）→ Task 9 Step 2/3 ✓
- lobehub 增强 + simple-icons 分层（D3/D4）→ Task 1 ✓
- 导航 Plug → Task 10 ✓
- 文件拆分（§5）→ Task 3-9 ✓
- ToggleGroup/SearchField 新建（§7）→ Task 2 ✓
- token 映射（§8）→ 散见 Task 3/4/8（`--lume-*`）✓
- 不变量（虚拟化/OAuth/跨页/IPC/事件）→ Task 1 保 ProviderIcon 测试、Task 5 保虚拟化、Task 6 保 OAuth 轮询、Task 9 保跨页+IPC+事件 ✓
- 范围假设（2 态）→ Task 9 placeholder 分支 ✓

**2. Placeholder scan:** Task 6 Step 3 的 LinkConnectDialog 函数体标注"从原 ProviderDialog 原样复制"——这是有据的机械迁移（源在 git 历史，给出精确行号 465-741 与 import 替换清单），非占位符；但为降低歧义，实施时应先复制完整函数体再改 import。其余无 TBD/TODO。

**3. Type consistency:**
- `IconKind` 加 `"simpleIcon"`（Task 1）→ ProviderIcon 消费（Task 1 Step 9）✓
- `LinkFilter`/`FilterCounts`（Task 4）→ LinkCatalog 消费（Task 5）→ LinkView 消费（Task 9）✓
- `LinkConnectDialog` props（Task 6）= 原 ProviderDialog props → Task 9 传参一致 ✓
- `LinkDetailPane` props（Task 8）→ Task 9 传参 ✓
- `ProviderCard` props 加 `needsAttention`/`selected`（Task 3）→ LinkCatalog 传参（Task 5）✓

无类型不一致。
