# 托盘设置重设计（Tray Settings Redesign）

> **已被取代。** 本文保留为历史设计记录；当前行为以桌面端实现、相关行为测试及 `docs/release/v0.1.6-tray-window-verification.md` 为准。旧文中的“新建笔记”、左键切换显隐、保留依赖设置值、专用单色派生和英文菜单不再适用。

- 日期：2026-07-08
- 状态：已被后续托盘与窗口行为方案取代
- 范围：`apps/desktop`（Electron 主进程）+ `apps/web` 设置页

## 背景

当前托盘（`apps/desktop/src/main.ts` 的 `createTray`）：

- 启动时**无条件**创建，没有"是否启用"开关
- macOS 图标用 512×512 的应用图标，已临时 `resize` 到 22pt（全彩，非 template）
- 右键菜单仅 `Show Lume` / `Quit`
- 左键单击 = 显示主窗口
- 设置页已有「最小化到托盘」「关闭到托盘」开关（`windowBehavior`，持久化 `settings.json`，`main.ts:498` 经 IPC 实时同步，`desktop-core.shouldHideToTray` 执行）

## 目标

1. 加「显示托盘」总开关（可关闭托盘）
2. 丰富右键菜单：快速输入 / 新建笔记 / 打开设置 / 检查更新
3. 图标改 template 单色（macOS，从 `icon.png` 派生）
4. 细化点击行为：左键 = 切换显隐

## 关键决策

- **D1（总开关语义）**：托盘关闭后遵循平台习惯——macOS 关窗驻 Dock；Win/Linux 关窗退出。托盘关闭时，「最小化到托盘」「关闭到托盘」开关在 UI 置灰（持久化值保留，恢复托盘时还原）
- **D2（菜单）**：`Show Lume`/`Hide Lume` + 快速输入 + 新建笔记 + 打开设置 + 检查更新 + `Quit`，含分隔符分组
- **D3（图标）**：运行时从 `icon.png` 派生单色 template（像素级处理），不新增资源
- **D4（点击）**：左键单击 = toggle 主窗口显隐；右键 = 菜单
- **D5（架构）**：方案 A——抽 `tray-manager.ts` + 纯逻辑下沉 `desktop-core.ts`（可测）+ `main.ts` 减负

## 架构

### 文件结构

- 新建 `apps/desktop/src/tray-manager.ts`：封装 Electron Tray
  - `createTray()` / `destroyTray()` / `rebuildMenu(state)` / `buildTrayIcon()`，模块内持有 tray 实例
- `apps/desktop/src/desktop-core.ts` 新增纯函数：
  - `buildTrayMenuTemplate(state)`：返回 Electron 菜单模板（纯数据）
  - `resolveCloseBehavior({ trayAvailable, windowBehavior, platform, isQuitting, eventType })`：统一最小化/关窗决策（扩展现有 `shouldHideToTray`）
  - `deriveTemplateImageBuffer(rgba, { width, height })`：RGBA → 单色（黑 + alpha）
- `apps/desktop/src/main.ts`：仅做生命周期接线
- `apps/desktop/scripts/desktop-core.test.mjs`：扩展测试

### 数据模型

`apps/web/src/components/settings/general-settings-state.ts` 的 `windowBehavior`：

- 新增 `showTray: boolean`，默认 `true`（向后兼容）
- `GeneralSettings.tsx`：新增「显示托盘」开关；`showTray=false` 时，「最小化到托盘」「关闭到托盘」开关 `disabled`
- IPC：复用现有 `update-window-behavior`（`main.ts:498`），`showTray` 变更即时生效

## 详细设计

### 托盘生命周期

- 启动（`app.whenReady`）：读 `settings.showTray` → `true` 调 `tray-manager.createTray()`；`false` 跳过
- 设置切换 `showTray`：`true → createTray()`；`false → tray.destroy()` 并清空实例
- 即时生效，无需重启

### 左键单击（D4）

- 主窗口可见且聚焦 → `hide`
- 否则 → `restore + show + focus`

### 右键菜单（D2）

顺序与分组：

```
Show Lume / Hide Lume        (label 随主窗口显隐动态切换)
────────────────
快速输入                      (主进程 createQuickInputWindow，复用现有)
新建笔记                      (显示 mainWindow + 主→渲染 IPC {action:'new-note'})
────────────────
打开设置                      (显示 mainWindow + IPC {action:'open-settings'})
检查更新                      (autoUpdater.checkForUpdates，复用 lume:update:check 逻辑)
────────────────
Quit                         (isQuitting=true; app.quit())
```

### IPC 新增（主 → 渲染）

- 通道：`lume:tray-action`，payload `{ action: 'open-settings' | 'new-note' }`
- 主进程：菜单 click → 确保 `mainWindow` 可见 → `mainWindow.webContents.send('lume:tray-action', { action })`
- 渲染层：经 preload 桥接（`desktop-api`）新增监听
  - `open-settings`：复用 `LeftSidebar.openSettings`（已存在，`LeftSidebar.tsx:110`）
  - `new-note`：触发新建笔记流程；若渲染层无现成入口，作为本阶段子任务在渲染层新增一个 dispatch 并由该监听调用

### 关窗 / 最小化规则（D1）

`resolveCloseBehavior`（扩展 `shouldHideToTray`）：

- `isQuitting` → 退出
- `trayAvailable=false`：
  - macOS：关窗不退出（驻 Dock）
  - Win/Linux：关窗退出
- `trayAvailable=true`：
  - `eventType='minimize'` → `windowBehavior.minimizeToTray`
  - `eventType='close'` → `windowBehavior.closeToTray`

### 图标派生（D3，仅 macOS）

`tray-manager.buildTrayIcon()`：

1. `nativeImage.createFromPath('icon.png').toBitmap()` → RGBA Buffer
2. `deriveTemplateImageBuffer(rgba, { width, height })` → 每 pixel 转 `RGB=(0,0,0)` + `alpha` 保留原值（黑色剪影 + 原透明度）
3. `nativeImage.createFromBuffer(processed)` → `setTemplateImage(true)` → `resize({ width:22, height:22 })`
- 非 macOS：`createFromPath(icon.ico / icon.png)` 原样（系统处理，不走 template）
- 失败回退：`try/catch` → `createFromPath('icon.png').resize({ 22, 22 })`（即当前行为）

## 错误处理

- 图标派生失败 → 回退全彩 resize，记日志
- `createTray()` / `destroyTray()` 异常 → guard + 日志，不影响窗口
- 设置 IPC 字段缺失 → 默认值（`showTray=true`）
- 菜单动作失败（如快速输入窗口创建失败）→ 日志，不抛出

## 测试

`apps/desktop/scripts/desktop-core.test.mjs` 扩展：

- `buildTrayMenuTemplate`：给定 `state`（窗口显/隐），断言模板结构（label 切换、分隔符位置、项顺序）
- `resolveCloseBehavior`：矩阵 `platform{darwin,win32,linux} × trayAvailable{0,1} × eventType{minimize,close} × isQuitting{0,1}`
- `deriveTemplateImageBuffer`：给定已知 RGBA（含不同 alpha 像素），断言输出 `RGB=0` 且 `alpha` 保留原值
- 原有 `shouldHideToTray` 用例迁移到 `resolveCloseBehavior`，回归通过

## 实施阶段

1. **重构**：抽 `tray-manager.ts` + 纯逻辑下沉 `desktop-core.ts`，**行为不变**，测试通过
2. **总开关**：`showTray` 字段 + 设置页 UI 联动 + `resolveCloseBehavior` 平台规则
3. **菜单 + 左键 toggle**：`buildTrayMenuTemplate` 扩展、左键切换显隐、`lume:tray-action` IPC（含渲染层监听与 new-note 入口）
4. **图标 template**：`buildTrayIcon` 像素派生 + 回退

## 非目标

- 不改 Dock 行为（仅沿用系统默认）
- 不引入新图标设计资源（用 `icon.png` 派生）
- 不改 Windows/Linux 托盘图标（沿用 `icon.ico`/`icon.png`）
