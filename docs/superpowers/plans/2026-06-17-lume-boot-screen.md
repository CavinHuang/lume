# Lume 启动页（Boot Screen）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lume 桌面应用（`apps/web`）实现启动页，用与应用视觉一致的「紫→品红」四阶段过渡盖住启动期空白（原生闪白 + React 挂载前 + healthcheck 等待）。

**Architecture:** 覆盖范围方案 B —— `apps/web/index.html` 内置静态启动层 `#boot-root`（窗口一开即绘制，含首绘前应用 `.dark` 的 no-flash 脚本 + 内联静态 CSS + 兜底色），React 组件 `LumeBootScreen` 挂载后从「唤醒」首帧无缝接管并移除静态层，按 `ready` 驱动 唤醒→整理→记忆→（就绪）序列，healthcheck 通过后停留就绪帧再淡出进入主界面。可测的纯逻辑抽到 `boot-phase.ts`。

**Tech Stack:** React 18 + TypeScript + Vite（`@` → `apps/web/src`）、Tailwind v4 / shadcn token（`--brand`/`--surface`/`--text-*`，`.dark` 切换）、纯 CSS keyframe 动画、`bun:test`（契约式测试，无 DOM/RTL）。

**Spec:** `docs/superpowers/specs/2026-06-17-lume-boot-screen-design.md`

**测试运行约定：** `apps/web` 无 `test` 脚本；用 `cd apps/web && bun test test/<file>.test.ts` 运行单个测试文件（bun 原生跑 TS，递归发现 `*.test.ts`）。契约测试沿用 `apps/web/test/lume-theme-contract.test.ts` 的「读源文件断言内容」风格。

**约定说明（YAGNI 取舍）：** 参考 `examples/lume_bootscreen_impl` 中的 demo 专用 prop（`autoPlay` 循环 / `showReplay` / `onSequenceEnd` / `steps`）**不移植**——真实启动只受 `ready` 驱动。仅保留 `scene?` 受控 prop 作为 spec §7 要求的「未来真实启动阶段」接入点。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/web/src/components/boot/boot-phase.ts` | 纯逻辑：阶段类型、时长常量、`resolveBootPhase`、`shouldShowHint`、`PHASE_COPY`、`BOOT_HINT` | 新建 |
| `apps/web/src/components/boot/useBootScreen.ts` | 驱动 hook：计时推进阶段、`ready`→就绪→停留→淡出→`onExited`；`scene` 受控覆盖 | 新建 |
| `apps/web/src/components/boot/LumeBootScreen.tsx` | 展示组件（基于参考改紫 + 改 logo + 受 `ready` 控制）；挂载后移除静态 `#boot-root` | 新建 |
| `apps/web/src/components/boot/lume-boot-screen.css` | 样式（参考改紫：sage → `var(--brand)`/`var(--brand-2)`，跟随 `.dark`） | 新建 |
| `apps/web/src/components/boot/index.ts` | barrel 导出 | 新建 |
| `apps/web/test/boot-phase.test.ts` | `boot-phase.ts` 运行时单测（TDD） | 新建 |
| `apps/web/test/boot-screen-contract.test.ts` | 静态层/组件/集成的契约断言 | 新建 |
| `apps/web/index.html` | 静态 `#boot-root` + no-flash 主题脚本 + 内联静态 boot CSS | 修改 |
| `apps/web/public/boot-logo.png` | 静态层 logo（拷贝自 `src/assets/imgs/logo.png`） | 新建 |
| `apps/web/src/App.tsx` | `if(!ready) return null` → `<LumeBootScreen>`；引入 `bootDone` 过渡 | 修改 |

---

## Task 1: 纯阶段逻辑 + 单测（TDD）

**Files:**
- Test: `apps/web/test/boot-phase.test.ts`
- Create: `apps/web/src/components/boot/boot-phase.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/boot-phase.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import {
  BOOT_HINT,
  BOOT_TIMINGS,
  PHASE_COPY,
  resolveBootPhase,
  shouldShowHint,
} from '../src/components/boot/boot-phase'

describe('resolveBootPhase', () => {
  test('awaken within the awaken window', () => {
    expect(resolveBootPhase(false, 0)).toBe('awaken')
    expect(resolveBootPhase(false, BOOT_TIMINGS.awakenMs - 1)).toBe('awaken')
  })

  test('organize after the awaken window', () => {
    expect(resolveBootPhase(false, BOOT_TIMINGS.awakenMs)).toBe('organize')
    const organizeEnd = BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs
    expect(resolveBootPhase(false, organizeEnd - 1)).toBe('organize')
  })

  test('memory rests after the organize window until ready', () => {
    const organizeEnd = BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs
    expect(resolveBootPhase(false, organizeEnd)).toBe('memory')
    expect(resolveBootPhase(false, organizeEnd + 999_999)).toBe('memory')
  })

  test('ready overrides elapsed time', () => {
    expect(resolveBootPhase(true, 0)).toBe('ready')
    expect(resolveBootPhase(true, 9_999)).toBe('ready')
  })
})

describe('shouldShowHint', () => {
  test('hidden while ready', () => {
    expect(shouldShowHint(true, 9_999)).toBe(false)
  })

  test('hidden before the threshold while waiting', () => {
    expect(shouldShowHint(false, 0)).toBe(false)
    expect(shouldShowHint(false, BOOT_TIMINGS.hintThresholdMs - 1)).toBe(false)
  })

  test('shown at/after the threshold while waiting', () => {
    expect(shouldShowHint(false, BOOT_TIMINGS.hintThresholdMs)).toBe(true)
    expect(shouldShowHint(false, 9_999)).toBe(true)
  })
})

describe('copy assets', () => {
  test('every phase has non-empty copy', () => {
    const phases = ['awaken', 'organize', 'memory', 'ready'] as const
    for (const phase of phases) {
      const copy = PHASE_COPY[phase]
      expect(copy.status.length).toBeGreaterThan(0)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.subtitle.length).toBeGreaterThan(0)
    }
  })

  test('slow-boot hint is non-empty', () => {
    expect(BOOT_HINT.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test test/boot-phase.test.ts`
Expected: FAIL —— `Cannot find module '../src/components/boot/boot-phase'`

- [ ] **Step 3: 写最小实现**

创建 `apps/web/src/components/boot/boot-phase.ts`：

```ts
export type LumeBootPhase = 'awaken' | 'organize' | 'memory' | 'ready'

export interface BootPhaseCopy {
  status: string
  title: string
  subtitle: string
}

/**
 * 启动序列时长（ms）。唤醒、整理为定时过渡；记忆为等待后端的「resting」循环态。
 * 就绪停留/淡出由 useBootScreen 按 ready 触发。
 */
export const BOOT_TIMINGS = {
  awakenMs: 1800,
  organizeMs: 3000,
  readyHoldMs: 500,
  fadeMs: 300,
  hintThresholdMs: 5000,
} as const

export const PHASE_COPY: Record<LumeBootPhase, BootPhaseCopy> = {
  awaken: {
    status: '正在唤醒',
    title: '正在唤醒 Lume',
    subtitle: '像轻轻睁开眼睛一样，让启动更安静，也更有陪伴感。',
  },
  organize: {
    status: '正在整理',
    title: '正在整理你的工作现场',
    subtitle: '最近窗口、会话与工作上下文，正在被轻轻整理到位。',
  },
  memory: {
    status: '正在连接记忆',
    title: '正在连接记忆与当前窗口',
    subtitle: '历史记忆与此刻的桌面上下文，正在一点点重新连上。',
  },
  ready: {
    status: '准备好了',
    title: '准备好了',
    subtitle: '一切已就绪，正在进入主界面。',
  },
}

export const BOOT_HINT = '首次启动或本地数据较多时，可能需要多等几秒。'

/**
 * 由就绪状态与已耗时解析当前可见阶段。
 * - ready 为真时恒为 'ready'（与耗时无关）。
 * - 否则：唤醒 → 整理 → 记忆（记忆态循环直到 ready）。
 */
export function resolveBootPhase(ready: boolean, elapsedMs: number): LumeBootPhase {
  if (ready) return 'ready'
  if (elapsedMs < BOOT_TIMINGS.awakenMs) return 'awaken'
  if (elapsedMs < BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs) return 'organize'
  return 'memory'
}

/** 仅在等待且超过阈值时显示「慢启动」提示。 */
export function shouldShowHint(ready: boolean, elapsedMs: number): boolean {
  return !ready && elapsedMs >= BOOT_TIMINGS.hintThresholdMs
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && bun test test/boot-phase.test.ts`
Expected: PASS（全部用例通过）

- [ ] **Step 5: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/boot/boot-phase.ts apps/web/test/boot-phase.test.ts
git commit -m "✨ feat(web): 启动页阶段驱动纯逻辑 + 单测"
```

---

## Task 2: 静态 logo 资源 + 静态启动层（index.html）

**Files:**
- Create: `apps/web/public/boot-logo.png`（拷贝自 `apps/web/src/assets/imgs/logo.png`）
- Modify: `apps/web/index.html`
- Test: `apps/web/test/boot-screen-contract.test.ts`

- [ ] **Step 1: 拷贝 logo 到 public/**

Run:
```bash
mkdir -p apps/web/public
cp apps/web/src/assets/imgs/logo.png apps/web/public/boot-logo.png
```
Expected: `apps/web/public/boot-logo.png` 存在（Vite 将 `public/` 原样映射到根路径，bundle 加载前即可用 `/boot-logo.png`）。

- [ ] **Step 2: 写静态层契约测试（失败）**

创建 `apps/web/test/boot-screen-contract.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('boot static layer (index.html)', () => {
  const indexHtml = readWebFile('index.html')

  test('defines a #boot-root static layer', () => {
    expect(indexHtml).toContain('id="boot-root"')
    expect(indexHtml).toContain('/boot-logo.png')
  })

  test('applies the theme before first paint (no-flash)', () => {
    expect(indexHtml).toContain("localStorage.getItem('lume:theme-mode')")
    expect(indexHtml).toContain("classList.add('dark')")
    expect(indexHtml).toContain("prefers-color-scheme: dark")
  })

  test('static CSS uses violet brand fallback colors, not the example sage', () => {
    expect(indexHtml).not.toContain('147,167,123')
    expect(indexHtml).toContain('139,92,246')
  })
})

describe('boot logo asset', () => {
  test('public/boot-logo.png exists', () => {
    expect(existsSync(join(webRoot, 'public', 'boot-logo.png'))).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: FAIL —— `index.html` 缺少 `#boot-root` 等。

- [ ] **Step 4: 改写 `apps/web/index.html`**

将 `apps/web/index.html` 全文替换为：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lume</title>
    <script>
      // 在首次绘制前应用主题，避免启动页主题闪屏。
      // 逻辑与 src/lib/theme-mode.ts 的 resolveShouldUseDark 一致。
      ;(function () {
        try {
          var mode = localStorage.getItem('lume:theme-mode')
          if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system'
          var prefersDark =
            window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          if (mode === 'dark' || (mode === 'system' && prefersDark)) {
            document.documentElement.classList.add('dark')
          }
        } catch (e) {
          /* ignore */
        }
      })()
    </script>
    <style>
      /* 静态启动层 —— 仅「唤醒」首帧。兜底色由应用 token 推导（spec §8.2）。
         React 挂载后会渲染同款「唤醒」帧并移除此 #boot-root，交接不可见。 */
      #boot-root {
        position: fixed;
        inset: 0;
        z-index: 50;
      }
      .lume-boot-static {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: linear-gradient(180deg, #fafbfd 0%, #ffffff 30%, #f3f4f8 100%);
      }
      .dark .lume-boot-static {
        background: linear-gradient(180deg, #202024 0%, #1a1a1d 32%, #242428 100%);
      }
      .lume-boot-static-halo {
        position: absolute;
        width: 460px;
        height: 460px;
        border-radius: 50%;
        filter: blur(16px);
        background: radial-gradient(
          circle at 50% 45%,
          rgba(139, 92, 246, 0.13),
          rgba(192, 38, 211, 0.06) 45%,
          transparent 72%
        );
        animation: lume-boot-static-halo 3.6s ease-in-out infinite;
      }
      .dark .lume-boot-static-halo {
        background: radial-gradient(
          circle at 50% 45%,
          rgba(167, 139, 250, 0.16),
          rgba(217, 70, 190, 0.09) 45%,
          transparent 72%
        );
      }
      .lume-boot-static-logo {
        position: relative;
        z-index: 2;
        width: 200px;
        height: auto;
        filter: drop-shadow(0 16px 30px rgba(0, 0, 0, 0.18));
        animation: lume-boot-static-breathe 2.8s ease-in-out infinite;
        user-select: none;
        -webkit-user-drag: none;
      }
      .lume-boot-static-status {
        position: absolute;
        bottom: 24%;
        left: 0;
        right: 0;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
        font-size: 14px;
        letter-spacing: 0.04em;
        color: #6a6a78;
      }
      .dark .lume-boot-static-status {
        color: #9b9ba8;
      }
      @keyframes lume-boot-static-breathe {
        0%,
        100% {
          transform: scale(0.97);
        }
        50% {
          transform: scale(1.03);
        }
      }
      @keyframes lume-boot-static-halo {
        0%,
        100% {
          transform: scale(0.95);
          opacity: 0.85;
        }
        50% {
          transform: scale(1.05);
          opacity: 1;
        }
      }
    </style>
  </head>
  <body>
    <div id="boot-root">
      <div class="lume-boot-static">
        <div class="lume-boot-static-halo"></div>
        <img class="lume-boot-static-logo" src="/boot-logo.png" alt="Lume" />
        <div class="lume-boot-static-status">正在唤醒 Lume</div>
      </div>
    </div>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/index.html apps/web/public/boot-logo.png apps/web/test/boot-screen-contract.test.ts
git commit -m "✨ feat(web): index.html 静态启动层 + 主题不闪屏 + 静态 logo"
```

---

## Task 3: React 层启动页样式（改紫）

**Files:**
- Create: `apps/web/src/components/boot/lume-boot-screen.css`
- Test: 追加到 `apps/web/test/boot-screen-contract.test.ts`

- [ ] **Step 1: 追加 CSS 契约断言（失败）**

在 `apps/web/test/boot-screen-contract.test.ts` 末尾追加：

```ts
describe('boot React CSS (lume-boot-screen.css)', () => {
  const css = readWebFile('src', 'components', 'boot', 'lume-boot-screen.css')

  test('uses app brand tokens, not the example sage palette', () => {
    expect(css).not.toContain('147,167,123')
    expect(css).toContain('var(--brand)')
    expect(css).toContain('var(--brand-2)')
  })

  test('derives background from app surface/background tokens', () => {
    expect(css).toContain('var(--surface-1)')
    expect(css).toContain('var(--background)')
  })

  test('keeps the four scene layers and keyframes', () => {
    expect(css).toContain('lume-boot-scene-organize')
    expect(css).toContain('lume-boot-scene-memory')
    expect(css).toContain('lume-boot-scene-ready')
    expect(css).toContain('@keyframes')
  })

  test('supports the fade-out class', () => {
    expect(css).toContain('.lume-boot-root.is-fading')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: FAIL —— `lume-boot-screen.css` 不存在。

- [ ] **Step 3: 写改紫后的完整 CSS**

创建 `apps/web/src/components/boot/lume-boot-screen.css`：

```css
/*
 * Lume 启动页样式 —— 基于参考实现改紫（sage → --brand/--brand-2），跟随应用 .dark。
 * 颜色全部经应用 token 解析；结构/动画沿用参考 examples/lume_bootscreen_impl。
 */
.lume-boot-root {
  --lb-ease-main: cubic-bezier(0.22, 1, 0.36, 1);
  --lb-ease-soft: cubic-bezier(0.33, 1, 0.68, 1);
  --lb-fade: 300ms;
  --lb-shadow: 0 18px 60px color-mix(in oklab, var(--shadow-panel) 30%, transparent);

  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100vh;
  overflow: hidden;
  isolation: isolate;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Helvetica Neue',
    sans-serif;
  color: var(--text-1);
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--surface-1) 88%, var(--background)) 0%,
    var(--background) 30%,
    color-mix(in oklab, var(--surface-2) 54%, var(--background)) 100%
  );
  transition: opacity var(--lb-fade) var(--lb-ease-soft);
}

.lume-boot-root.is-fading {
  opacity: 0;
}

.lume-boot-screen {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

/* ── 顶部状态标签 ── */
.lume-boot-status-chip {
  position: absolute;
  top: 28px;
  left: 50%;
  z-index: 12;
  transform: translateX(-50%);
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--text-2);
  background: color-mix(in oklab, var(--foreground) 5%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(10px);
}

/* ── 品牌光晕（紫→品红，低透明度） ── */
.lume-boot-soft-halo {
  position: absolute;
  width: 450px;
  height: 450px;
  border-radius: 50%;
  filter: blur(18px);
  z-index: 1;
  opacity: 0.84;
  transform: scale(0.96);
  background: radial-gradient(
    circle at center,
    color-mix(in oklab, var(--brand) 18%, transparent),
    color-mix(in oklab, var(--brand-2) 6%, transparent) 42%,
    transparent 76%
  );
  transition: opacity 980ms var(--lb-ease-soft), transform 980ms var(--lb-ease-soft);
}

/* ── 场景层（organize / memory / ready） ── */
.lume-boot-scene-layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  transform: scale(0.988) translateY(8px);
  transition: opacity 860ms var(--lb-ease-main), transform 860ms var(--lb-ease-main);
  pointer-events: none;
  z-index: 3;
}

.lume-boot-scene-layer.active {
  opacity: 1;
  transform: scale(1) translateY(0);
}

/* ── 中心 logo ── */
.lume-boot-center-shell {
  position: relative;
  z-index: 6;
  width: 250px;
  height: 250px;
  display: grid;
  place-items: center;
}

.lume-boot-logo {
  width: 210px;
  height: auto;
  display: block;
  transform-origin: center bottom;
  filter: drop-shadow(0 18px 32px color-mix(in oklab, var(--shadow-panel) 22%, transparent));
  user-select: none;
  -webkit-user-drag: none;
  animation: lume-boot-mascot-breathe 2.8s ease-in-out infinite;
}

/* ── 文案 ── */
.lume-boot-copy {
  position: absolute;
  top: calc(50% + 148px);
  left: 50%;
  z-index: 8;
  transform: translateX(-50%);
  width: min(620px, 86vw);
  text-align: center;
  animation: lume-boot-copy-in 420ms var(--lb-ease-main) both;
}

.lume-boot-title {
  font-size: 30px;
  line-height: 1.28;
  font-weight: 700;
  letter-spacing: 0.01em;
  margin-bottom: 12px;
  color: var(--text-1);
}

.lume-boot-subtitle {
  min-height: 26px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-2);
}

.lume-boot-dots {
  margin-top: 22px;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
}

.lume-boot-dots span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 72%, transparent);
  animation: lume-boot-dot-pulse 1.4s ease-in-out infinite;
}

.lume-boot-dots span:nth-child(2) {
  animation-delay: 0.18s;
}
.lume-boot-dots span:nth-child(3) {
  animation-delay: 0.36s;
}

.lume-boot-footer-hint {
  position: absolute;
  left: 50%;
  bottom: 82px;
  z-index: 9;
  transform: translateX(-50%);
  width: min(580px, 86vw);
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.7;
}

.lume-boot-stage-indicator {
  position: absolute;
  left: 50%;
  bottom: 36px;
  z-index: 10;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
}

.lume-boot-stage-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 18%, transparent);
  transition: all 360ms var(--lb-ease-main);
}

.lume-boot-stage-indicator span.active {
  width: 22px;
  background: color-mix(in oklab, var(--brand) 72%, transparent);
}

/* ── organize 场景：流动卡片 ── */
.lume-boot-card-node {
  position: absolute;
  width: 96px;
  height: 64px;
  border-radius: 18px;
  opacity: 0;
  border: 1px solid var(--border);
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--foreground) 7%, transparent),
    color-mix(in oklab, var(--foreground) 4%, transparent)
  );
  backdrop-filter: blur(10px);
  box-shadow: var(--lb-shadow);
}

.lume-boot-card-node::before {
  content: '';
  position: absolute;
  left: 16px;
  top: 16px;
  width: 42px;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 38%, transparent);
}

.lume-boot-card-node::after {
  content: '';
  position: absolute;
  left: 16px;
  top: 30px;
  width: 58px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 18%, transparent);
}

.lume-boot-card-a {
  left: calc(50% - 272px);
  top: calc(50% - 110px);
}
.lume-boot-card-b {
  left: calc(50% + 176px);
  top: calc(50% - 116px);
}
.lume-boot-card-c {
  left: calc(50% - 232px);
  top: calc(50% + 90px);
}
.lume-boot-card-d {
  left: calc(50% + 184px);
  top: calc(50% + 94px);
}

.lume-boot-scene-organize.active .lume-boot-card-a {
  animation: lume-boot-card-flow-a 3.6s var(--lb-ease-soft) infinite;
}
.lume-boot-scene-organize.active .lume-boot-card-b {
  animation: lume-boot-card-flow-b 3.6s var(--lb-ease-soft) infinite 0.22s;
}
.lume-boot-scene-organize.active .lume-boot-card-c {
  animation: lume-boot-card-flow-c 3.6s var(--lb-ease-soft) infinite 0.48s;
}
.lume-boot-scene-organize.active .lume-boot-card-d {
  animation: lume-boot-card-flow-d 3.6s var(--lb-ease-soft) infinite 0.72s;
}

/* ── memory 场景：记忆环 + 漂浮光点 ── */
.lume-boot-memory-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 50%;
  border: 1px solid color-mix(in oklab, var(--brand) 22%, transparent);
  transform: translate(-50%, -50%);
  opacity: 0;
}

.lume-boot-memory-ring.r1 {
  width: 260px;
  height: 260px;
}
.lume-boot-memory-ring.r2 {
  width: 324px;
  height: 324px;
}
.lume-boot-memory-ring.r3 {
  width: 390px;
  height: 390px;
}

.lume-boot-memory-orb {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  opacity: 0;
  background: radial-gradient(circle at 35% 35%, #fff, var(--brand));
  box-shadow: 0 0 18px color-mix(in oklab, var(--brand) 45%, transparent);
}

.lume-boot-orb-1 {
  left: calc(50% - 178px);
  top: calc(50% - 86px);
}
.lume-boot-orb-2 {
  left: calc(50% + 164px);
  top: calc(50% - 78px);
}
.lume-boot-orb-3 {
  left: calc(50% - 136px);
  top: calc(50% + 152px);
}
.lume-boot-orb-4 {
  left: calc(50% + 132px);
  top: calc(50% + 148px);
}

.lume-boot-scene-memory.active .lume-boot-memory-ring.r1 {
  animation: lume-boot-ring-pulse 3s var(--lb-ease-soft) infinite;
}
.lume-boot-scene-memory.active .lume-boot-memory-ring.r2 {
  animation: lume-boot-ring-pulse 3s var(--lb-ease-soft) infinite 0.3s;
}
.lume-boot-scene-memory.active .lume-boot-memory-ring.r3 {
  animation: lume-boot-ring-pulse 3s var(--lb-ease-soft) infinite 0.6s;
}
.lume-boot-scene-memory.active .lume-boot-orb-1 {
  animation: lume-boot-orb-move-1 3.5s var(--lb-ease-soft) infinite;
}
.lume-boot-scene-memory.active .lume-boot-orb-2 {
  animation: lume-boot-orb-move-2 3.5s var(--lb-ease-soft) infinite 0.3s;
}
.lume-boot-scene-memory.active .lume-boot-orb-3 {
  animation: lume-boot-orb-move-3 3.5s var(--lb-ease-soft) infinite 0.6s;
}
.lume-boot-scene-memory.active .lume-boot-orb-4 {
  animation: lume-boot-orb-move-4 3.5s var(--lb-ease-soft) infinite 0.9s;
}

/* ── ready 场景：就绪环 ── */
.lume-boot-ready-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 50%;
  border: 1px solid color-mix(in oklab, var(--brand) 38%, transparent);
  transform: translate(-50%, -50%);
  opacity: 0;
}

.lume-boot-ready-ring.r1 {
  width: 236px;
  height: 236px;
}
.lume-boot-ready-ring.r2 {
  width: 288px;
  height: 288px;
}
.lume-boot-ready-ring.r3 {
  width: 340px;
  height: 340px;
}

.lume-boot-scene-ready.active .lume-boot-ready-ring.r1 {
  animation: lume-boot-ready-pulse 2.6s var(--lb-ease-soft) infinite;
}
.lume-boot-scene-ready.active .lume-boot-ready-ring.r2 {
  animation: lume-boot-ready-pulse 2.6s var(--lb-ease-soft) infinite 0.28s;
}
.lume-boot-scene-ready.active .lume-boot-ready-ring.r3 {
  animation: lume-boot-ready-pulse 2.6s var(--lb-ease-soft) infinite 0.56s;
}

/* ── 阶段驱动的光晕/中心微调 ── */
.lume-boot-root[data-phase='awaken'] .lume-boot-soft-halo {
  opacity: 0.82;
  transform: scale(0.96);
}
.lume-boot-root[data-phase='organize'] .lume-boot-soft-halo {
  opacity: 0.92;
  transform: scale(1.03);
}
.lume-boot-root[data-phase='memory'] .lume-boot-soft-halo {
  opacity: 0.96;
  transform: scale(1.08);
}
.lume-boot-root[data-phase='ready'] .lume-boot-soft-halo {
  opacity: 1;
  transform: scale(1.12);
}

/* ── keyframes ── */
@keyframes lume-boot-mascot-breathe {
  0%,
  100% {
    transform: scale(0.988);
  }
  50% {
    transform: scale(1);
  }
}
@keyframes lume-boot-copy-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes lume-boot-dot-pulse {
  0%,
  80%,
  100% {
    opacity: 0.34;
    transform: scale(0.82);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes lume-boot-card-flow-a {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.82);
  }
  18% {
    opacity: 0.85;
  }
  62% {
    opacity: 0.94;
    transform: translate(156px, 76px) scale(0.99);
  }
  100% {
    opacity: 0;
    transform: translate(184px, 90px) scale(0.92);
  }
}
@keyframes lume-boot-card-flow-b {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.82);
  }
  18% {
    opacity: 0.85;
  }
  62% {
    opacity: 0.94;
    transform: translate(-156px, 82px) scale(0.99);
  }
  100% {
    opacity: 0;
    transform: translate(-184px, 94px) scale(0.92);
  }
}
@keyframes lume-boot-card-flow-c {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.82);
  }
  18% {
    opacity: 0.85;
  }
  62% {
    opacity: 0.94;
    transform: translate(116px, -72px) scale(0.99);
  }
  100% {
    opacity: 0;
    transform: translate(138px, -86px) scale(0.92);
  }
}
@keyframes lume-boot-card-flow-d {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.82);
  }
  18% {
    opacity: 0.85;
  }
  62% {
    opacity: 0.94;
    transform: translate(-116px, -78px) scale(0.99);
  }
  100% {
    opacity: 0;
    transform: translate(-138px, -90px) scale(0.92);
  }
}
@keyframes lume-boot-ring-pulse {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.92);
  }
  30% {
    opacity: 0.18;
  }
  60% {
    opacity: 0.26;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.1);
  }
}
@keyframes lume-boot-orb-move-1 {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.55);
  }
  18% {
    opacity: 1;
  }
  62% {
    opacity: 1;
    transform: translate(120px, 70px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(138px, 84px) scale(0.72);
  }
}
@keyframes lume-boot-orb-move-2 {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.55);
  }
  18% {
    opacity: 1;
  }
  62% {
    opacity: 1;
    transform: translate(-120px, 72px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-138px, 86px) scale(0.72);
  }
}
@keyframes lume-boot-orb-move-3 {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.55);
  }
  18% {
    opacity: 1;
  }
  62% {
    opacity: 1;
    transform: translate(86px, -112px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(102px, -126px) scale(0.72);
  }
}
@keyframes lume-boot-orb-move-4 {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.55);
  }
  18% {
    opacity: 1;
  }
  62% {
    opacity: 1;
    transform: translate(-90px, -108px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-106px, -124px) scale(0.72);
  }
}
@keyframes lume-boot-ready-pulse {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.84);
  }
  34% {
    opacity: 0.22;
  }
  66% {
    opacity: 0.3;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.16);
  }
}

@media (max-width: 860px) {
  .lume-boot-status-chip {
    top: 20px;
  }
  .lume-boot-center-shell {
    width: 220px;
    height: 220px;
  }
  .lume-boot-logo {
    width: 188px;
  }
  .lume-boot-copy {
    top: calc(50% + 132px);
    width: 86vw;
  }
  .lume-boot-title {
    font-size: 26px;
  }
  .lume-boot-footer-hint {
    width: 86vw;
    bottom: 78px;
  }
  .lume-boot-card-a {
    left: 10vw;
    top: calc(50% - 120px);
  }
  .lume-boot-card-b {
    left: auto;
    right: 10vw;
    top: calc(50% - 118px);
  }
  .lume-boot-card-c {
    left: 14vw;
    top: calc(50% + 82px);
  }
  .lume-boot-card-d {
    left: auto;
    right: 14vw;
    top: calc(50% + 86px);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: PASS（含新增 CSS 契约）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/boot/lume-boot-screen.css apps/web/test/boot-screen-contract.test.ts
git commit -m "✨ feat(web): 启动页 React 层样式（改紫，跟随主题）"
```

---

## Task 4: 驱动 hook `useBootScreen`

**Files:**
- Create: `apps/web/src/components/boot/useBootScreen.ts`

- [ ] **Step 1: 写 hook**

创建 `apps/web/src/components/boot/useBootScreen.ts`：

```ts
import { useEffect, useRef, useState } from 'react'
import {
  BOOT_TIMINGS,
  resolveBootPhase,
  shouldShowHint,
  type LumeBootPhase,
} from './boot-phase'

export interface UseBootScreenOptions {
  /** 后端是否就绪。为 true 时进入「就绪」并触发淡出退出。 */
  ready: boolean
  /** 受控阶段覆盖；提供时跳过 ready 驱动序列（未来真实启动阶段接入点）。 */
  scene?: LumeBootPhase
  /** 淡出完成后回调（App 据此渲染主界面）。 */
  onExited?: () => void
}

export interface BootScreenState {
  phase: LumeBootPhase
  fading: boolean
  showHint: boolean
}

/**
 * 启动页驱动：
 * - 等待后端期间按计时推进 唤醒→整理→记忆（记忆循环）。
 * - ready 为真时立即进入「就绪」，停留 readyHoldMs，淡出 fadeMs，再回调 onExited。
 * - scene 受控时直接显示该阶段。
 */
export function useBootScreen({ ready, scene, onExited }: UseBootScreenOptions): BootScreenState {
  const [phase, setPhase] = useState<LumeBootPhase>('awaken')
  const [fading, setFading] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const startRef = useRef<number | null>(null)
  const exitStartedRef = useRef(false)

  // 等待期间：计时推进阶段 + 慢启动提示。
  useEffect(() => {
    if (scene !== undefined || ready) return
    if (startRef.current === null) startRef.current = performance.now()
    let raf = requestAnimationFrame(function tick() {
      const elapsed = performance.now() - (startRef.current ?? 0)
      setPhase(resolveBootPhase(false, elapsed))
      setShowHint(shouldShowHint(false, elapsed))
      raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [ready, scene])

  // ready：进入就绪 → 停留 → 淡出 → 退出。
  useEffect(() => {
    if (scene !== undefined || !ready || exitStartedRef.current) return
    exitStartedRef.current = true
    setPhase('ready')
    setShowHint(false)
    const fadeTimer = window.setTimeout(() => setFading(true), BOOT_TIMINGS.readyHoldMs)
    const exitTimer = window.setTimeout(
      () => onExited?.(),
      BOOT_TIMINGS.readyHoldMs + BOOT_TIMINGS.fadeMs,
    )
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(exitTimer)
    }
  }, [ready, scene, onExited])

  // 受控覆盖。
  useEffect(() => {
    if (scene !== undefined) setPhase(scene)
  }, [scene])

  return { phase, fading, showHint }
}
```

- [ ] **Step 2: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/boot/useBootScreen.ts
git commit -m "✨ feat(web): 启动页驱动 hook useBootScreen"
```

---

## Task 5: 展示组件 `LumeBootScreen` + barrel

**Files:**
- Create: `apps/web/src/components/boot/LumeBootScreen.tsx`
- Create: `apps/web/src/components/boot/index.ts`
- Test: 追加到 `apps/web/test/boot-screen-contract.test.ts`

- [ ] **Step 1: 追加组件契约断言（失败）**

在 `apps/web/test/boot-screen-contract.test.ts` 末尾追加：

```ts
describe('boot component (LumeBootScreen.tsx)', () => {
  const component = readWebFile('src', 'components', 'boot', 'LumeBootScreen.tsx')

  test('is driven by ready and removes the static layer on mount', () => {
    expect(component).toContain('ready')
    expect(component).toContain("getElementById('boot-root')")
    expect(component).toContain('.remove()')
  })

  test('renders the four scene layers and consumes boot-phase copy', () => {
    expect(component).toContain('lume-boot-scene-organize')
    expect(component).toContain('lume-boot-scene-memory')
    expect(component).toContain('lume-boot-scene-ready')
    expect(component).toContain('PHASE_COPY')
    expect(component).toContain('data-phase')
  })

  test('exports a barrel', () => {
    const barrel = readWebFile('src', 'components', 'boot', 'index.ts')
    expect(barrel).toContain('LumeBootScreen')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: FAIL —— 组件文件不存在。

- [ ] **Step 3: 写组件**

创建 `apps/web/src/components/boot/LumeBootScreen.tsx`：

```tsx
import { useEffect } from 'react'
import { BOOT_HINT, BOOT_TIMINGS, PHASE_COPY, type LumeBootPhase } from './boot-phase'
import { useBootScreen } from './useBootScreen'
import './lume-boot-screen.css'

export interface LumeBootScreenProps {
  logoSrc: string
  ready: boolean
  /** 受控阶段覆盖（未来真实启动阶段接入点）。 */
  scene?: LumeBootPhase
  onExited?: () => void
}

const STAGES: readonly LumeBootPhase[] = ['awaken', 'organize', 'memory', 'ready'] as const

export function LumeBootScreen({ logoSrc, ready, scene, onExited }: LumeBootScreenProps) {
  const { phase, fading, showHint } = useBootScreen({ ready, scene, onExited })
  const copy = PHASE_COPY[phase]

  // 从 index.html 静态层无缝交接：React 已绘制同款「唤醒」帧后移除静态层。
  useEffect(() => {
    const el = document.getElementById('boot-root')
    if (el) el.remove()
  }, [])

  return (
    <div
      className={`lume-boot-root${fading ? ' is-fading' : ''}`}
      data-phase={phase}
      style={{ ['--lb-fade' as string]: `${BOOT_TIMINGS.fadeMs}ms` }}
    >
      <div className="lume-boot-screen">
        <div className="lume-boot-status-chip">{copy.status}</div>
        <div className="lume-boot-soft-halo" />

        <div
          className={`lume-boot-scene-layer lume-boot-scene-organize${
            phase === 'organize' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-card-node lume-boot-card-a" />
          <div className="lume-boot-card-node lume-boot-card-b" />
          <div className="lume-boot-card-node lume-boot-card-c" />
          <div className="lume-boot-card-node lume-boot-card-d" />
        </div>

        <div
          className={`lume-boot-scene-layer lume-boot-scene-memory${
            phase === 'memory' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-memory-ring r1" />
          <div className="lume-boot-memory-ring r2" />
          <div className="lume-boot-memory-ring r3" />
          <div className="lume-boot-memory-orb lume-boot-orb-1" />
          <div className="lume-boot-memory-orb lume-boot-orb-2" />
          <div className="lume-boot-memory-orb lume-boot-orb-3" />
          <div className="lume-boot-memory-orb lume-boot-orb-4" />
        </div>

        <div
          className={`lume-boot-scene-layer lume-boot-scene-ready${
            phase === 'ready' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-ready-ring r1" />
          <div className="lume-boot-ready-ring r2" />
          <div className="lume-boot-ready-ring r3" />
        </div>

        <div className="lume-boot-center-shell">
          <img className="lume-boot-logo" src={logoSrc} alt="Lume logo" />
        </div>

        <div className="lume-boot-copy" key={phase}>
          <div className="lume-boot-title">{copy.title}</div>
          <div className="lume-boot-subtitle">{copy.subtitle}</div>
          <div className="lume-boot-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>

        {showHint && <div className="lume-boot-footer-hint">{BOOT_HINT}</div>}

        <div className="lume-boot-stage-indicator" aria-hidden="true">
          {STAGES.map((p) => (
            <span key={p} className={phase === p ? 'active' : ''} />
          ))}
        </div>
      </div>
    </div>
  )
}

export default LumeBootScreen
```

创建 `apps/web/src/components/boot/index.ts`：

```ts
export { LumeBootScreen, default } from './LumeBootScreen'
export type { LumeBootScreenProps } from './LumeBootScreen'
export { useBootScreen } from './useBootScreen'
export type { BootScreenState, UseBootScreenOptions } from './useBootScreen'
export {
  BOOT_TIMINGS,
  PHASE_COPY,
  BOOT_HINT,
  resolveBootPhase,
  shouldShowHint,
} from './boot-phase'
export type { LumeBootPhase, BootPhaseCopy } from './boot-phase'
```

- [ ] **Step 4: 运行契约测试确认通过**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/boot/LumeBootScreen.tsx apps/web/src/components/boot/index.ts apps/web/test/boot-screen-contract.test.ts
git commit -m "✨ feat(web): 启动页组件 LumeBootScreen + barrel"
```

---

## Task 6: 集成到 `App.tsx`（bootDone 过渡）

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: 追加到 `apps/web/test/boot-screen-contract.test.ts`

- [ ] **Step 1: 追加集成契约断言（失败）**

在 `apps/web/test/boot-screen-contract.test.ts` 末尾追加：

```ts
describe('boot integration (App.tsx)', () => {
  const app = readWebFile('src', 'App.tsx')

  test('renders LumeBootScreen until boot is done', () => {
    expect(app).toContain('LumeBootScreen')
    expect(app).toContain('bootDone')
    expect(app).toContain('onExited')
  })

  test('keeps the healthcheck error branch', () => {
    expect(app).toContain('setError')
    expect(app).toContain('text-destructive')
  })

  test('uses the app logo as boot logo source', () => {
    expect(app).toContain('assets/imgs/logo.png')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: FAIL —— App.tsx 尚未集成启动页。

- [ ] **Step 3: 改 `apps/web/src/App.tsx`**

在文件顶部 import 区追加（与 `VersionUpdateSettings` 一致的 `new URL` 资源引用方式，无需额外的 png 模块类型声明）：

```ts
import { LumeBootScreen } from '@/components/boot'
```

并在 `App()` 上方加常量：

```ts
const BOOT_LOGO_URL = new URL('./assets/imgs/logo.png', import.meta.url).href
```

把 `App` 函数体中：

```ts
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

替换为：

```ts
  const [ready, setReady] = useState(false)
  const [bootDone, setBootDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
```

并把：

```ts
  if (!ready) return null
```

替换为：

```ts
  if (!ready || !bootDone) {
    return (
      <LumeBootScreen
        logoSrc={BOOT_LOGO_URL}
        ready={ready}
        onExited={() => setBootDone(true)}
      />
    )
  }
```

> 改完后 `App.tsx` 的渲染优先级为：`error` 分支（最高）→ `(!ready || !bootDone)` 显示启动页 → 主界面。healthcheck 成功 → `ready=true` → 启动页播「就绪」+ 淡出 → `onExited` → `bootDone=true` → 主界面。

- [ ] **Step 4: 运行契约测试确认通过**

Run: `cd apps/web && bun test test/boot-screen-contract.test.ts`
Expected: PASS（全部 boot 相关契约通过）

- [ ] **Step 5: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/App.tsx apps/web/test/boot-screen-contract.test.ts
git commit -m "✨ feat(web): App 集成启动页 + bootDone 过渡"
```

---

## Task 7: 全量校验 + 手动验证

**Files:** 无新增（仅运行校验）

- [ ] **Step 1: 跑全部 web 测试**

Run: `cd apps/web && bun test`
Expected: PASS（含新增 `boot-phase.test.ts`、`boot-screen-contract.test.ts`，且既有契约测试不回归）

- [ ] **Step 2: 全量 typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 生产构建，确认静态产物进 dist**

Run: `cd apps/web && bun run build`
Expected: 构建成功；`apps/web/dist/` 下含 `boot-logo.png`（public 资产原样拷贝），index.html 内联了静态启动层。

可执行确认：
```bash
ls apps/web/dist/boot-logo.png
grep -c 'boot-root' apps/web/dist/index.html   # 期望 >=1
```

- [ ] **Step 4: 手动验证（dev）**

Run（项目根）: `bun run dev`
在浏览器/桌面应用中验证：
1. 窗口一出现即显示紫色调启动页（无白屏），logo 呼吸 + 紫色光晕。
2. 切换系统/应用主题（浅/深），重启验证首绘即为正确主题（不闪屏）。
3. 等待期间可见 唤醒→整理（流动卡片）→记忆（环+光点）过渡；超过 ~5s 出现底部提示。
4. 后端就绪后：出现「准备好了」就绪环 → ~0.5s 后淡出 → 进入主界面，无跳变。
5. 模拟后端不可用（如停 sidecar）：~10s 后显示现有错误屏（而非就绪）。

- [ ] **Step 5: 提交（如有遗留改动）**

```bash
git status
# 若有未提交改动：
git add -A && git commit -m "✅ test(web): 启动页全量校验通过"
```

---

## 自检（计划作者已完成）

- **Spec 覆盖**：覆盖范围 B（Task 2 静态层 + Task 5/6 接管）、logo `logo.png`（Task 2 public + Task 6 import）、配色复用 token（Task 3 改紫）、完整四阶段（Task 1/3/4/5）、ready 即跳就绪 + 停留淡出（Task 4）、hint >5s（Task 1/4）、App bootDone 过渡 + error 优先（Task 6）、no-flash（Task 2）——均有对应 task。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码与命令。
- **类型/命名一致**：`LumeBootPhase`、`BOOT_TIMINGS`、`resolveBootPhase`、`shouldShowHint`、`PHASE_COPY`、`BOOT_HINT`、`useBootScreen`、`BootScreenState`、`LumeBootScreen`、`bootDone`、`BOOT_LOGO_URL` 在各 task 间一致。
- **风险点**：① 静态层与 React 层「唤醒」帧需像素对齐（两者 logo 同源、兜底色按 spec §8.2 推导，Task 7 手动验证交接）；② CSS `--lb-fade` 由组件按 `BOOT_TIMINGS.fadeMs` 注入，保持单一来源。
```
