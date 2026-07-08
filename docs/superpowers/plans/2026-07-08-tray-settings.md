# 托盘设置重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 macOS/Win/Linux 桌面端的系统托盘加上「显示托盘」总开关、丰富的右键菜单、template 单色图标、左键切换显隐。

**Architecture:** 方案 A——抽 `apps/desktop/src/tray-manager.ts` 封装 Electron Tray；菜单模板、图标派生、关窗规则这类纯函数下沉 `apps/desktop/src/desktop-core.ts`（配 `node:test` 单测）；`main.ts` 只做生命周期接线；设置项经现有 `windowBehavior` 数据模型 + `desktop_sync_window_behavior` IPC 端到端打通。

**Tech Stack:** Electron 42、TypeScript、`node:test` + `node:assert`、Tailwind（web 设置页）、`@lume/shared`（共享类型，需 `bun run build`）。

**Spec:** `docs/superpowers/specs/2026-07-08-tray-settings-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/desktop/src/desktop-core.ts` | 纯逻辑：菜单模板、图标派生、关窗规则、设置读取 | 新增 `buildTrayMenuTemplate` / `deriveTemplateImageBuffer`；扩展 `readWindowBehaviorFromConfigDir` |
| `apps/desktop/src/tray-manager.ts` | Electron Tray 封装：创建/销毁、菜单绑定、图标构建、左键 toggle | 新建 |
| `apps/desktop/src/main.ts` | 生命周期接线：启动建托盘、IPC 同步、关窗规则 | 修改 |
| `apps/desktop/src/preload.ts` | IPC 桥接白名单 | 加 `tray-action` event channel |
| `apps/desktop/scripts/desktop-core.test.mjs` | 纯函数单测 | 扩展 |
| `packages/shared/src/types/general-settings.ts` | `windowBehavior` 类型 + 默认值 | 加 `showTray` |
| `apps/web/src/components/settings/general-settings-state.ts` | `mergeGeneralSettings` | 处理 `showTray` |
| `apps/web/src/components/settings/GeneralSettings.tsx` | 设置 UI | 加「显示托盘」开关 + 联动禁用 |
| `apps/web/src/components/app-shell/LeftSidebar.tsx` | 渲染层监听 `tray-action` | 新增 `useEffect` |

---

## 阶段 1：重构（行为不变，纯逻辑下沉 + 抽 tray-manager）

### Task 1: 下沉 `buildTrayMenuTemplate` 纯函数（当前菜单：Show Lume / Quit）

**Files:**
- Modify: `apps/desktop/src/desktop-core.ts`（末尾追加 export）
- Test: `apps/desktop/scripts/desktop-core.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 `desktop-core.test.mjs`，记得在顶部 import 加入 `buildTrayMenuTemplate`）

```js
test('tray menu template toggles Show/Hide label by window visibility', () => {
  const hidden = buildTrayMenuTemplate({ windowVisible: false })
  assert.equal(hidden[0].label, 'Show Lume')
  assert.equal(hidden[0].action, 'toggle-window')
  assert.equal(hidden[hidden.length - 1].label, 'Quit')
  assert.equal(hidden[hidden.length - 1].action, 'quit')

  const visible = buildTrayMenuTemplate({ windowVisible: true })
  assert.equal(visible[0].label, 'Hide Lume')
  assert.equal(visible[0].action, 'toggle-window')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: FAIL — `buildTrayMenuTemplate is not defined`

- [ ] **Step 3: 实现**（追加到 `desktop-core.ts`）

```ts
export type TrayMenuAction = 'toggle-window' | 'quick-input' | 'new-note' | 'open-settings' | 'check-update' | 'quit'

export interface TrayMenuItem {
  label?: string
  action?: TrayMenuAction
  type?: 'separator'
}

export function buildTrayMenuTemplate({ windowVisible }: { windowVisible: boolean }): TrayMenuItem[] {
  return [
    { label: windowVisible ? 'Hide Lume' : 'Show Lume', action: 'toggle-window' },
    { type: 'separator' },
    { label: 'Quit', action: 'quit' },
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-core.ts apps/desktop/scripts/desktop-core.test.mjs
git commit -m "♻️ refactor(desktop): 下沉 buildTrayMenuTemplate 纯函数"
```

---

### Task 2: 下沉 `deriveTemplateImageBuffer` 纯函数

**策略**：把彩色 RGBA 转成 template（`RGB=(0,0,0)`，`alpha` 保留原值）→ 黑色剪影 + 原透明度，macOS 据菜单栏明暗自动渲染。

**Files:**
- Modify: `apps/desktop/src/desktop-core.ts`
- Test: `apps/desktop/scripts/desktop-core.test.mjs`

- [ ] **Step 1: 写失败测试**（import 加入 `deriveTemplateImageBuffer`）

```js
test('deriveTemplateImageBuffer produces black pixels preserving original alpha', () => {
  // 像素：红不透明白、绿半透明、透明（alpha=0）
  const rgba = Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 128,
    0, 0, 0, 0,
  ])
  const out = deriveTemplateImageBuffer(rgba, { width: 3, height: 1 })
  assert.deepEqual(
    Array.from(out),
    [0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0],
  )
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: FAIL — `deriveTemplateImageBuffer is not defined`

- [ ] **Step 3: 实现**（追加到 `desktop-core.ts`）

```ts
export function deriveTemplateImageBuffer(
  rgba: Buffer,
  _size: { width: number; height: number },
): Buffer {
  const out = Buffer.alloc(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = 0
    out[i + 1] = 0
    out[i + 2] = 0
    out[i + 3] = rgba[i + 3]
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-core.ts apps/desktop/scripts/desktop-core.test.mjs
git commit -m "♻️ refactor(desktop): 下沉 deriveTemplateImageBuffer 纯函数"
```

---

### Task 3: 新建 `tray-manager.ts`，迁移现有 `createTray`（行为不变）

**Files:**
- Create: `apps/desktop/src/tray-manager.ts`
- Modify: `apps/desktop/src/main.ts:282-309`（删除 `createTray`，改调 tray-manager）、`:1004`（启动调用）

- [ ] **Step 1: 创建 `tray-manager.ts`**

```ts
import { Tray, Menu, nativeImage } from 'electron'
import { buildTrayMenuTemplate, type TrayMenuAction } from './desktop-core'

let tray: Tray | null = null

export function isTrayAvailable(): boolean {
  return Boolean(tray)
}

export function createTray(options: {
  iconPath: string
  onClickToggle: () => void
  onAction: (action: TrayMenuAction) => void
}) {
  if (tray) return tray
  const source = nativeImage.createFromPath(options.iconPath)
  // nativeImage.resize 返回新对象（非 mutate），需接住返回值
  const icon = process.platform === 'darwin' ? source.resize({ width: 22, height: 22 }) : source
  tray = new Tray(icon)
  tray.setToolTip('Lume')
  tray.on('click', () => options.onClickToggle())
  rebuildMenu({ windowVisible: false }, options.onAction)
  return tray
}

export function rebuildMenu(
  state: { windowVisible: boolean },
  onAction: (action: TrayMenuAction) => void,
) {
  if (!tray) return
  const template = buildTrayMenuTemplate(state).map((item) => {
    if (item.type === 'separator') return { type: 'separator' as const }
    return {
      label: item.label,
      click: () => item.action && onAction(item.action as TrayMenuAction),
    }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

export function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
```

- [ ] **Step 2: 改 `main.ts`——删除 `createTray`（:282-309），替换为接线**

把原 `function createTray() {...}` 整体删除，新增一个调度函数：

```ts
function handleTrayAction(action) {
  switch (action) {
    case 'toggle-window':
      toggleMainWindow()
      return
    case 'quit':
      isQuitting = true
      app.quit()
      return
    default:
      // 阶段 3 接入其余 action
      return
  }
}

function ensureTray() {
  if (trayManager.isTrayAvailable()) return
  trayManager.createTray({
    iconPath: getAssetPath(process.platform === 'darwin' ? 'icon.png' : 'icon.ico'),
    onClickToggle: () => toggleMainWindow(),
    onAction: handleTrayAction,
  })
}
```

在 `main.ts` 顶部 import 区加：
```ts
import * as trayManager from './tray-manager'
```
保留 `let tray = null`（仍被 `window-all-closed` 的 `!tray` 判断用到）——把它改为读 `trayManager.isTrayAvailable()`：见 Step 3。

- [ ] **Step 3: 把 `main.ts` 里对 `tray` 变量的读取改为 `trayManager.isTrayAvailable()`**

涉及行（`grep -n "tray" apps/desktop/src/main.ts` 确认）：
- `:311` `trayAvailable: Boolean(tray)` → `trayAvailable: trayManager.isTrayAvailable()`
- `:1047` `if (process.platform !== 'darwin' && !tray)` → `if (process.platform !== 'darwin' && !trayManager.isTrayAvailable())`
- `:1048` 之后（若有）同改

删除 `main.ts:95` 的 `let tray = null`（已由 tray-manager 持有）。

- [ ] **Step 4: 启动接线**——`:1003-1004`

把：
```ts
windowBehavior = readWindowBehaviorFromConfigDir(configDir)
createTray()
```
改为：
```ts
windowBehavior = readWindowBehaviorFromConfigDir(configDir)
ensureTray()
```

- [ ] **Step 5: 验证——typecheck + 手动**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过（无 TS 错误）

手动（必须）：完全退出并重启 desktop（`cd apps/desktop && bun ./scripts/dev.ts`，需 web dev server 在 3000 端口）。确认：
- 托盘图标出现，左键单击 = 切换主窗口显隐（之前是仅显示；现在已 toggle，符合 D4，行为微调可接受）
- 右键菜单 = Show/Hide Lume + Quit，点击 Show/Hide 切换显隐，点击 Quit 退出

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/tray-manager.ts apps/desktop/src/main.ts
git commit -m "♻️ refactor(desktop): 抽 tray-manager，托盘行为不变"
```

---

## 阶段 2：显示托盘总开关

### Task 4: shared 类型加 `showTray`

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts:5-8, 100-105`

- [ ] **Step 1: 改类型**（`:5-8` `GeneralSettingsWindowBehavior`）

```ts
export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
  showTray: boolean
}
```

- [ ] **Step 2: 改默认值**（`:100-105` `GENERAL_SETTINGS_DEFAULTS`）

```ts
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false,
    showTray: true,
  },
```

- [ ] **Step 3: 构建 shared**

Run: `cd packages/shared && bun run build`
Expected: `dist/types/general-settings.d.ts` 与 `.js` 含 `showTray`（`grep showTray packages/shared/dist/types/general-settings.d.ts` 有命中）

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/general-settings.ts packages/shared/dist
git commit -m "✨ feat(shared): windowBehavior 新增 showTray 字段"
```

---

### Task 5: `readWindowBehaviorFromConfigDir` 读 `showTray`

**Files:**
- Modify: `apps/desktop/src/desktop-core.ts:83-90`
- Test: `apps/desktop/scripts/desktop-core.test.mjs:51-87`

- [ ] **Step 1: 改测试断言**（更新 `:63-66`、`:76-79`、`:80-83` 三处 `assert.deepEqual`）

把每个期望对象补上 `showTray`：
```js
assert.deepEqual(readWindowBehaviorFromConfigDir(dir), {
  minimizeToTray: true,
  closeToTray: true,
  showTray: true,   // 默认 true
})
```
对 `minimizeToTray:true` 单字段用例：`showTray: true`（缺失走默认 true）。
对 missing 目录用例：`showTray: true`。

再加一条显式 `showTray:false` 用例：在 `:54` 的 settings.json 写入里加 `showTray: false`，断言 `showTray: false`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: FAIL（实际对象无 `showTray`）

- [ ] **Step 3: 实现**（改 `:83-90`）

```ts
export function readWindowBehaviorFromConfigDir(configDir) {
  const settings = parseJsonFile(join(configDir, 'settings.json'))
  const behavior = settings?.generalSettings?.windowBehavior
  return {
    minimizeToTray: typeof behavior?.minimizeToTray === 'boolean' ? behavior.minimizeToTray : false,
    closeToTray: typeof behavior?.closeToTray === 'boolean' ? behavior.closeToTray : false,
    showTray: typeof behavior?.showTray === 'boolean' ? behavior.showTray : true,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-core.ts apps/desktop/scripts/desktop-core.test.mjs
git commit -m "✨ feat(desktop): readWindowBehaviorFromConfigDir 读取 showTray"
```

---

### Task 6: `mergeGeneralSettings` 处理 `showTray`

**Files:**
- Modify: `apps/web/src/components/settings/general-settings-state.ts:69-72`

- [ ] **Step 1: 改 `mergeGeneralSettings` 的 `windowBehavior`**

```ts
    windowBehavior: {
      minimizeToTray: updates.windowBehavior?.minimizeToTray ?? base.windowBehavior.minimizeToTray,
      closeToTray: updates.windowBehavior?.closeToTray ?? base.windowBehavior.closeToTray,
      showTray: updates.windowBehavior?.showTray ?? base.windowBehavior.showTray,
    },
```

- [ ] **Step 2: 验证 typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 通过（shared 已 build，类型已含 `showTray`）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/general-settings-state.ts
git commit -m "✨ feat(web): mergeGeneralSettings 处理 showTray"
```

---

### Task 7: 设置页加「显示托盘」开关 + 联动禁用

**Files:**
- Modify: `apps/web/src/components/settings/GeneralSettings.tsx:219-250`

- [ ] **Step 1: 在「窗口行为」SettingsCard 顶部插入「显示托盘」行，并给下两行加 `disabled`**

把 `:219-250` 整块替换为：

```tsx
        <SettingsCard title="窗口行为">
          <div className="divide-y divide-[color:color-mix(in_oklab,var(--border)_64%,transparent)]">
            <SettingsRow
              label="显示托盘"
              desc="在系统菜单栏/任务栏显示 Lume 图标（关闭后重启应用生效）"
            >
              <LumeSwitch
                checked={settings.windowBehavior.showTray}
                disabled={saving}
                onCheckedChange={(checked) => void persistSettings({
                  windowBehavior: {
                    showTray: checked,
                  },
                }, '窗口行为已保存')}
              />
            </SettingsRow>
            <SettingsRow
              label="最小化到托盘"
              desc="点击最小化时保留后台运行"
            >
              <LumeSwitch
                checked={settings.windowBehavior.minimizeToTray}
                disabled={saving || !settings.windowBehavior.showTray}
                onCheckedChange={(checked) => void persistSettings({
                  windowBehavior: {
                    minimizeToTray: checked,
                  },
                }, '窗口行为已保存')}
              />
            </SettingsRow>
            <SettingsRow
              label="关闭到托盘"
              desc="关闭窗口时不退出应用"
            >
              <LumeSwitch
                checked={settings.windowBehavior.closeToTray}
                disabled={saving || !settings.windowBehavior.showTray}
                onCheckedChange={(checked) => void persistSettings({
                  windowBehavior: {
                    closeToTray: checked,
                  },
                }, '窗口行为已保存')}
              />
            </SettingsRow>
          </div>
        </SettingsCard>
```

- [ ] **Step 2: 验证 typecheck + 手动**

Run: `cd apps/web && bun run typecheck`
Expected: 通过

手动：浏览器打开 `http://localhost:3000` → 设置 → 窗口行为。确认：
- 「显示托盘」开关出现
- 关闭「显示托盘」时，下两个开关置灰
- 切换开关，`settings.json` 的 `generalSettings.windowBehavior.showTray` 更新（`cat ~/.lume/settings.json`）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/GeneralSettings.tsx
git commit -m "✨ feat(web): 设置页加「显示托盘」开关 + 联动禁用"
```

---

### Task 8: 主进程按 `showTray` 创建/销毁托盘

**Files:**
- Modify: `apps/desktop/src/main.ts`（`dispatchCommand` 的 `desktop_sync_window_behavior` :497-499、启动 :1003）

- [ ] **Step 1: 改 `dispatchCommand` 的 `desktop_sync_window_behavior` 分支**

```ts
    case 'desktop_sync_window_behavior': {
      const previous = windowBehavior
      windowBehavior = payload.windowBehavior ?? windowBehavior
      if (previous?.showTray !== windowBehavior?.showTray) {
        if (windowBehavior?.showTray) ensureTray()
        else trayManager.destroyTray()
      }
      return null
    }
```

- [ ] **Step 2: 改启动接线**（`:1003-1004` 区域）

```ts
  windowBehavior = readWindowBehaviorFromConfigDir(configDir)
  if (windowBehavior?.showTray !== false) ensureTray()
  logDesktopStartup('tray ready')
```

- [ ] **Step 3: 验证 typecheck + 手动**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过

手动：重启 desktop。确认：
- 默认（showTray=true）→ 托盘出现
- 设置页关闭「显示托盘」→ 托盘**立即消失**（无需重启）
- macOS：托盘消失后关主窗口 → 窗口关闭、应用驻留 Dock（点 Dock 图标可恢复）
- Win/Linux：托盘消失后关主窗口 → 应用退出
- 重新开启「显示托盘」→ 托盘**立即出现**

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "✨ feat(desktop): 按 showTray 创建/销毁托盘"
```

---

## 阶段 3：菜单扩展 + 左键 toggle + IPC

### Task 9: 扩展 `buildTrayMenuTemplate` 为完整菜单

**Files:**
- Modify: `apps/desktop/src/desktop-core.ts`（Task 1 的 `buildTrayMenuTemplate`）
- Test: `apps/desktop/scripts/desktop-core.test.mjs`

- [ ] **Step 1: 更新 Task 1 的测试，补完整结构断言**

```js
test('tray menu template toggles Show/Hide label by window visibility', () => {
  const hidden = buildTrayMenuTemplate({ windowVisible: false })
  assert.deepEqual(hidden.map((i) => i.label ?? i.type), [
    'Show Lume', 'separator', '快速输入', '新建笔记', 'separator', '打开设置', '检查更新', 'separator', 'Quit',
  ])
  assert.equal(hidden[0].action, 'toggle-window')
  assert.equal(hidden[2].action, 'quick-input')
  assert.equal(hidden[3].action, 'new-note')
  assert.equal(hidden[5].action, 'open-settings')
  assert.equal(hidden[6].action, 'check-update')
  assert.equal(hidden[8].action, 'quit')

  const visible = buildTrayMenuTemplate({ windowVisible: true })
  assert.equal(visible[0].label, 'Hide Lume')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: FAIL（当前模板只有 3 项）

- [ ] **Step 3: 实现**（替换 Task 1 的 `buildTrayMenuTemplate`）

```ts
export function buildTrayMenuTemplate({ windowVisible }: { windowVisible: boolean }): TrayMenuItem[] {
  return [
    { label: windowVisible ? 'Hide Lume' : 'Show Lume', action: 'toggle-window' },
    { type: 'separator' },
    { label: '快速输入', action: 'quick-input' },
    { label: '新建笔记', action: 'new-note' },
    { type: 'separator' },
    { label: '打开设置', action: 'open-settings' },
    { label: '检查更新', action: 'check-update' },
    { type: 'separator' },
    { label: 'Quit', action: 'quit' },
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test ./scripts/desktop-core.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-core.ts apps/desktop/scripts/desktop-core.test.mjs
git commit -m "✨ feat(desktop): 托盘菜单模板扩展为完整菜单"
```

---

### Task 10: tray-manager 绑定 action + 主窗口显隐刷新菜单 label

**Files:**
- Modify: `apps/desktop/src/main.ts`（`handleTrayAction`、`toggleMainWindow`、窗口显隐事件）

- [ ] **Step 1: 在 `main.ts` 实现完整的 `toggleMainWindow` 与刷新逻辑**

```ts
function refreshTrayMenu() {
  const windowVisible = Boolean(mainWindow) && !mainWindow.isDestroyed() && mainWindow.isVisible()
  trayManager.rebuildMenu({ windowVisible }, handleTrayAction)
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const visible = mainWindow.isVisible() && mainWindow.isFocused()
  if (visible) mainWindow.hide()
  else restoreMainWindow(mainWindow)
  refreshTrayMenu()
}
```

- [ ] **Step 2: `handleTrayAction` 补齐 action**（替换 Task 3 的版本）

```ts
function handleTrayAction(action) {
  switch (action) {
    case 'toggle-window':
      toggleMainWindow()
      return
    case 'quick-input':
      toggleQuickInput().catch((error) => console.error(`[desktop] quick input toggle failed: ${error.message}`))
      return
    case 'new-note':
      showMainWindowThenSend({ action: 'new-note' })
      return
    case 'open-settings':
      showMainWindowThenSend({ action: 'open-settings' })
      return
    case 'check-update':
      checkForUpdateNow()
      return
    case 'quit':
      isQuitting = true
      app.quit()
      return
  }
}

function showMainWindowThenSend(payload: { action: string }) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) restoreMainWindow(mainWindow)
  mainWindow.webContents.send('lume:event:tray-action', payload)
}

function checkForUpdateNow() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.checkForUpdates().catch((error) => console.error(`[desktop] update check failed: ${error.message}`))
}
```

- [ ] **Step 3: 窗口显隐时刷新菜单**——在 `attachWindowBehavior`（`main.ts:325-337`）的 `hide` 后、以及 `showMainWindow` 后调 `refreshTrayMenu()`

`attachWindowBehavior` 的 minimize/close `win.hide()` 后加 `refreshTrayMenu()`；`showMainWindow()`（:321-323）`restoreMainWindow` 后加 `refreshTrayMenu()`。

- [ ] **Step 4: 验证 typecheck + 手动**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过

手动：重启 desktop，右键托盘。确认 9 项菜单（3 分组分隔）；点 `Show/Hide Lume` 切换显隐且 label 随之切换；点 `快速输入` 弹出子窗口；点 `Quit` 退出。（`打开设置`/`新建笔记` 需 Task 12 渲染层监听后才生效；`检查更新` 仅打包后有效。）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "✨ feat(desktop): 托盘菜单 action 绑定 + 显隐刷新 label"
```

---

### Task 11: preload 放行 `tray-action` event channel

**Files:**
- Modify: `apps/desktop/src/preload.ts:32-37`

- [ ] **Step 1: 加白名单**

```ts
const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
  'window-state',
  'tray-action',
])
```

- [ ] **Step 2: 验证 typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/preload.ts
git commit -m "✨ feat(desktop): preload 放行 tray-action 事件通道"
```

---

### Task 12: 渲染层监听 `tray-action`

**Files:**
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`（已有 `openSettings` :110、`handleNewThread` :101）

- [ ] **Step 1: 在 `LeftSidebar` 组件内加 `useEffect` 监听**

顶部确保 import 了 `useEffect`（若已有则跳过）。在组件体内（`openSettings`/`handleNewThread` 定义之后）加：

```tsx
  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { listen?: (channel: string, listener: (payload: { action: string }) => void) => (() => void) | undefined } }).electronAPI
    const off = electronAPI?.listen?.('tray-action', ({ action }) => {
      if (action === 'open-settings') openSettings()
      else if (action === 'new-note') handleNewThread()
    })
    return () => off?.()
  }, [])
```

- [ ] **Step 2: 验证 typecheck + 手动**

Run: `cd apps/web && bun run typecheck`
Expected: 通过

手动：重启 desktop，主窗口可见时右键托盘 → 点 `打开设置` → 主窗口前置并切到设置 tab；点 `新建笔记` → 切到 welcome/new tab。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app-shell/LeftSidebar.tsx
git commit -m "✨ feat(web): 监听 tray-action 触发打开设置/新建笔记"
```

---

## 阶段 4：图标 template（macOS）

### Task 13: `buildTrayIcon` 集成 `deriveTemplateImageBuffer` + 回退

**Files:**
- Modify: `apps/desktop/src/tray-manager.ts`（Task 3 的 `createTray` 图标构建段）

- [ ] **Step 1: 抽出 `buildTrayIcon` 并改 `createTray` 调用它**

在 `tray-manager.ts` 顶部 import 加 `deriveTemplateImageBuffer`：
```ts
import { buildTrayMenuTemplate, deriveTemplateImageBuffer, type TrayMenuAction } from './desktop-core'
```

新增函数 + 改 `createTray` 用它：

```ts
function buildTrayIcon(iconPath: string): Electron.NativeImage {
  const source = nativeImage.createFromPath(iconPath)
  if (process.platform !== 'darwin') return source
  try {
    const size = source.getSize()
    const rgba = source.toBitmap()
    const templateRgba = deriveTemplateImageBuffer(rgba, size)
    const icon = nativeImage.createFromBuffer(templateRgba, {
      width: size.width,
      height: size.height,
    })
    // resize 返回新对象；template 标记要打在最终（resize 后）的 image 上
    const sized = icon.resize({ width: 22, height: 22 })
    sized.setTemplateImage(true)
    return sized
  } catch {
    const fallback = nativeImage.createFromPath(iconPath)
    fallback.resize({ width: 22, height: 22 })
    return fallback
  }
}
```

把 `createTray` 里：
```ts
  const icon = nativeImage.createFromPath(options.iconPath)
  if (process.platform === 'darwin') {
    icon.resize({ width: 22, height: 22 })
  }
```
替换为：
```ts
  const icon = buildTrayIcon(options.iconPath)
```

- [ ] **Step 2: 验证 typecheck + 手动**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过

手动：重启 desktop（macOS）。确认：
- 托盘图标为**单色剪影**，且随系统菜单栏深/浅模式自动反色（系统设置切深色 → 图标变浅；切浅色 → 图标变深）
- 图标尺寸正常（~22pt，不巨大）
- 若派生异常（看主进程日志），回退为全彩 22pt 图标，不崩

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/tray-manager.ts
git commit -m "✨ feat(desktop): macOS 托盘图标改 template 单色派生"
```

---

## 收尾

### Task 14: 全量回归

- [ ] **Step 1: 跑所有相关测试**

```bash
cd apps/desktop && bun test ./scripts/desktop-core.test.mjs
cd packages/shared && bun test
```
Expected: 全 PASS

- [ ] **Step 2: 两端 typecheck**

```bash
cd apps/web && bun run typecheck
cd apps/desktop && bun run typecheck
```
Expected: 通过

- [ ] **Step 3: 手动回归清单**（重启 desktop）

- 默认托盘显示，图标单色 template（macOS）、尺寸正常
- 左键单击 = 切换主窗口显隐
- 右键 9 项菜单全部可用，`Show/Hide Lume` label 随显隐切换
- 设置页关「显示托盘」→ 托盘立即消失；下两开关置灰
- 托盘消失后：macOS 关窗驻 Dock、Win/Linux 关窗退出
- 重新开「显示托盘」→ 立即恢复
- 「最小化到托盘」「关闭到托盘」在托盘开启时行为不变（回归）

- [ ] **Step 4: 最终 commit（如有残留改动）**

```bash
git add -A
git commit -m "✅ test(desktop): 托盘重设计回归"
```

---

## 备注

- **派生策略**：`deriveTemplateImageBuffer` 采用「保留原 alpha、RGB 置黑」实现黑色剪影。若实际图标在菜单栏上对比度不理想（例如 logo 本身是浅色），可在该函数内改为 `alpha = 255 - 亮度`（亮度反相）——这是 spec 原始描述，函数签名不变，只换内部像素映射即可。
- **shared 改动后必须 build**（Task 4 Step 3），否则 web/desktop 拿不到新 `dist` 类型。
- **每个 Task 的手动验证都要求完全退出 desktop 再重启**——托盘/主进程代码不走 HMR。
