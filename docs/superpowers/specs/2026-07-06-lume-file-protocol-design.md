# lume-file 协议：thread + workspace 图片预览

**日期**: 2026-07-06
**状态**: 已批准（设计），待实现
**关联**: `2026-06-14-file-link-context-menu-design.md`（文件链接上下文菜单 / 路径解析）

## 1. 背景与动机

右侧面板与对话附件预览 thread 图片时，现有实现走 IPC `READ_THREAD_FILE_DATA` 取 base64，再 `<img src="data:...">`（见 `RuntimeEventContentBlock.useThreadImageAttachmentSrcs`、`FilesRightPanelTab` 本轮新增的图片分支）。问题：

- base64 膨胀 ×1.33，整图进入 JS 堆，大图占用内存且解码阻塞主线程。
- workspace 图片完全无预览通道（后端无 `readWorkspaceFileData`）。

`localFilePreviewUrl` 返回 `file://`，但 `createSecureWebPreferences`（`electron-security.ts:159`）默认 `webSecurity:true`，阻止 `lume://` 源跨源加载 `file://`，故全项目图片渲染目前皆用 base64。

## 2. 目标 / 非目标

**目标**

- thread + workspace 图片经自定义协议流式渲染（不 base64、不进 JS 堆），由 Chromium 原生解码。
- 顺便支持 workspace 图片预览（当前缺失）。
- 不降低安全姿态（路径校验严格、多层）。

**非目标**

- 文本预览（保留 `READ_FILE` 的截断 / null-byte 检测价值）。
- local source（用户拖入的任意磁盘文件）图片——不在可信根，保留 base64。
- 视频 / 音频 / PDF（本次仅图片）。

## 3. 架构

### 3.1 scheme 注册（`apps/desktop/src/main.ts`）

在现有 `protocol.registerSchemesAsPrivileged([...])`（`main.ts:118`）数组中追加：

```js
{ scheme: 'lume-file', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
```

### 3.2 handler（`main.ts` 的 `registerAppProtocol` 同区）

新增 `protocol.handle('lume-file', handler)`，逻辑见 §4。

### 3.3 URL 格式

```
lume-file://file/<encodeURIComponent(absolutePath)>
```

编码绝对路径 → main 无需了解 thread/workspace 目录布局，只做"该绝对路径是否在可信根内"。

### 3.4 CSP（`apps/web/index.html:7`）

当前 `img-src 'self' data: blob: file: https: http:`，增补 `lume-file:`：

```
img-src 'self' data: blob: file: https: http: lume-file:
```

同步检查 `apps/web/scripts/security-policy.test.mjs` 与 `scripts/verify-desktop-package-inputs.mjs` 的 CSP 断言是否需更新（若二者断言 img-src 具体内容）。

## 4. 安全校验规格（核心攻击面）

handler 伪码：

```js
handler(request):
  // 1) URL 编码层面攻击（复用 resolveAppProtocolFilePath 的反穿越模式）
  if (/%(?:00|2e|2f|5c)/i.test(request.url)) return 403

  raw = pathname after "lume-file://file/" from request.url
  abs = decodeURIComponent(raw)
  norm = path.resolve(abs)                                   // 规范化，吃掉 ../ 与 .

  // 2) 白名单根
  if (!norm.startsWith(workspacesRoot + path.sep)) return 403

  // 3) 禁 UNC（Windows）
  if (path.sep === '\\' && norm.startsWith('\\\\')) return 403

  // 4) symlink 逃逸：realpath 解析后仍须在根下
  real = realpathSync(norm)                                  // 异常 → 404
  if (!real.startsWith(workspacesRoot + path.sep)) return 403

  // 5) 必须是文件
  if (!existsSync(real) || !statSync(real).isFile()) return 404

  return net.fetch(pathToFileURL(real))                      // Chromium 流式解码
```

- `workspacesRoot = path.join(configDir, 'agent-workspaces')`。
- `configDir` 复用 main 现有解析（与 `desktop-core.ts readWindowBehaviorFromConfigDir` 同源），确保与 sidecar 一致。

## 5. renderer 迁移

| 位置 | 现状 | 改为 |
|---|---|---|
| `FilesRightPanelTab` | base64（`READ_THREAD_FILE_DATA` + data URL，本轮刚加） | 撤回 base64 分支；`src={lumeFileUrl(selectedPath)}`。selectedPath 已绝对（thread 与 workspace 均可），顺便让 workspace 图片首次可预览 |
| `RuntimeEventContentBlock.useThreadImageAttachmentSrcs` | base64（`READ_THREAD_FILE_DATA`） | 改 `resolveAbsolutePath(ctx)`（复用 `file-link-actions`）→ `lumeFileUrl(abs)`；不再读文件内容 |
| `AgentInput` / `WelcomeView` / `agent-file-drop` | base64（`attachmentDataUrl`，local source） | **不改**（local 文件不在可信根） |

**新增工具** `lumeFileUrl(absPath)`：`lume-file://file/${encodeURIComponent(absPath)}`，放 `file-preview-utils.ts`（与 `isImageFile` 同处）。

**`file-preview-utils.ts` 调整**：保留 `isImageFile`（仍用于"是否走图片渲染分支"）；删除 `imageMimeType` / `imageDataUrl`（协议方式无需 MIME，Chromium 从文件内容嗅探）。相应更新 `file-preview-utils.test.ts`。

## 6. 错误处理

- handler: `403`（越界 / UNC / symlink 逃逸 / 编码攻击）、`404`（不存在 / 非文件）、`500`（读异常）。
- `<img onError>`：显示占位（`FileTypeIcon` + "无法预览"），避免裸露 broken icon。

## 7. 测试计划

**main（参照 `apps/desktop/scripts/electron-security.test.mjs`）**

- 合法：workspacesRoot 下 png → 200 + image content-type。
- 穿越：`lume-file://file/${enc(workspacesRoot)}/../secret` → 403。
- URL 编码攻击：`%2e%2e` / `%5c..%5c` / `%00` → 403。
- UNC（Windows）：`\\server\share\x` → 403。
- symlink 越界：workspacesRoot 内 symlink 指向根外 → 403。
- 不存在 / 目录非文件 → 404。

**renderer**

- `lumeFileUrl(path)` 编码正确（纯函数测试，加入 `file-preview-utils.test.ts`）。
- 撤回点：更新 `useThreadImageAttachmentSrcs` 相关测试期望（不再 expect data URL）。

## 8. 决策记录

- **main 自校验 vs 委托 sidecar**：选 main 自校验——图片加载对延迟敏感，避免每图一次 main→sidecar IPC；main 已有 configDir 与 `electron-security` 校验模式可复用。代价：main 新增校验代码（新攻击面），靠 §4 多层校验 + §7 矩阵缓解。
- **编码绝对路径 vs 逻辑参数**：选绝对路径——main 与 sidecar 目录布局解耦，布局变更时协议层零改动。
- **local source 保留 base64**：local 文件是用户任意磁盘路径，不在 `.lume/agent-workspaces` 可信根，白名单会拒绝。保留 base64 是安全约束的自然结果。
- **symlink 策略**：realpath 校验通过即允许（非完全拒绝）——可信根内的合法 symlink（如 macOS `.lume` 经符号链接到其他卷）仍可用；越界 symlink 由 realpath 校验拦截。

## 9. 风险

- 路径校验疏漏 = 越权读任意文件。缓解：§4 多层校验 + §7 矩阵 + 复用已审 `electron-security` 模式。
- CSP 配置遗漏 → `<img>` 被拦。缓解：§3.4 精确增补 + 验证两个 CSP 测试脚本。
- main 与 sidecar 的 configDir 解析不一致 → workspacesRoot 偏差。缓解：复用同一 configDir 解析逻辑。
