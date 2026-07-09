# WebFetch 增强：JS 渲染抓取 + 图片/资产本地化

- 日期：2026-07-09
- 范围：`packages/sdk`（WebFetch 工具）、`apps/desktop`（渲染服务 + reverse-RPC）、`apps/sidecar`（IPC 桥 + 图片管线）
- 状态：设计中

## 1. 背景与动机

当前 `WebFetch`（`packages/sdk/src/tools/web-fetch.ts`）是**纯静态抓取**：全局 `fetch`
→ 截断 100k 字符 → JSDOM + Readability 抽正文 → Turndown 转 Markdown。

三个无法满足的需求：

1. **JS 渲染页面抓不到**：客户端渲染的 SPA（React/Vue 应用、动态加载内容）静态 fetch
   只拿到空壳 HTML，Readability 抽不出正文。
2. **图片丢失/失效**：图片不下载；懒加载页图片真实 URL 在 `data-src`（非 `src`）被
   Readability/Turndown 丢弃或保留为失效链接；`mmbiz.qpic.cn` 等有防盗链（Referer 校验），
   保留原始 URL 在别处打不开。典型例子：微信公众号文章
   （`https://mp.weixin.qq.com/s/...`）。
3. **抓取结果即用即弃**：Markdown 仅作为 tool 返回值进入 agent 上下文，无法作为可复用
   资产持久化。

> 关键事实（调研确认）：微信公众号文章**正文是服务端渲染**在初始 HTML
> （`<div id="js_content">`）里的，静态 fetch 即可拿到正文。真正痛点是图片 `data-src`
> 懒加载 + `mmbiz.qpic.cn` 防盗链。因此微信文章多数不需要 JS 渲染，但 JS 渲染是更通用
> 的 SPA 场景所需——本设计采用**分层方案**兼顾两者。

## 2. 目标

1. **分层抓取**：默认走现有静态管线（快）；静态结果无效时自动回退到 Electron `webContents`
   渲染；支持强制渲染 / 关闭渲染。
2. **图片本地化**：下载图片到本地，Markdown 用 `lume-file://` 本地路径引用，绕防盗链
   （带正确 Referer），处理懒加载（`data-src` 修正）。
3. **资产持久化**：原文 HTML 转 Markdown，与图片一起作为**资产包**存到 workspace
   目录，可复用、可引用。
4. **零新运行时依赖**：不引入 Playwright / Puppeteer / Jina，复用 Electron 已打包的
   Chromium（`webContents`）。
5. **仅桌面端**：渲染回退仅在 Electron 内可用；headless sidecar/CLI 优雅降级为纯静态
   + 警告。

## 3. 非目标

- 不抓取 PDF / 附件等"其他资源"（用户提到"等资源"，留作后续，本期只做图片）。
- 不引入第三方 headless browser 或托管渲染服务。
- 不并入未落地的「统一浏览器运行时」大设计
  （`docs/superpowers/specs/2026-07-02-unified-browser-runtime-design.md`）。本设计的渲染
  通道是**单一用途**的（只服务抓取渲染），不泛化为 sidecar→main 通用 RPC 框架。
- 不改变 `WebFetch` 的工具名与基本调用方式（增强参数，不新增工具）。
- 不做多模态：图片只进 Markdown（本地路径），不作为 image content block 传给 LLM。

## 4. 关键决策（已确认）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 场景策略 | 分层（静态优先 + JS 页回退渲染） | 兼顾性能与 SPA 覆盖 |
| D2 | 运行环境 | 仅桌面端，复用 Electron `webContents` | 零新依赖，契合项目"不引新依赖"哲学 |
| D3 | 图片处理 | 下载本地 + Markdown 引用本地路径 + 防盗链 Referer | 持久化、UI 可显示、绕防盗链 |
| D4 | 架构形态 | 增强现有 `WebFetch`（加 `render`/`images` 参数） | 改动最小、入口统一 |
| D5 | 渲染通道 | reverse-RPC（sidecar→main 拦截通知 + 回调） | agent 工具跑在 sidecar，无 renderer 中间人，renderer 编排不适用自动化 |
| D6 | 图片存储目录 | `agent-workspaces/<slug>/resources/` | `lume-file://` 可信根已覆盖，零协议改动即可 UI 显示 |
| D7 | 资产形态 | md + 图片同目录自包含资产包 | 抓取结果可复用、可引用、可整体迁移 |

## 5. 总体架构与数据流

```text
agent 调 WebFetch(url, { render:"auto", images:"download" })
  │  运行在 sidecar（packages/sdk）
  ▼
① 域名沙箱校验（沿用 ensureNetworkAllowed）
  ▼
② 静态抓取：sdkFetch(url) → rawHtml
  ▼
③ 触发判定 shouldRender(rawHtml, render)：决定 finalHtml 来源
     render="off"                                  → finalHtml = rawHtml
     render="force"                                → ④ 渲染
     render="auto" 且 rawHtml 为 SPA 空壳/正文极少  → ④ 渲染
     render="auto" 且 rawHtml 正常                  → finalHtml = rawHtml
  ▼
④ 渲染回退（核心新增，仅 force / auto 触发）：
     sidecar callMain("render:request", {url, options})
       → main 拦截 → 隐藏 webContents.loadURL → 等渲染就绪
       → executeJavaScript 序列化 DOM → 返回 renderedHtml
     finalHtml = renderedHtml
  ▼
⑤ 图片管线 downloadAndLocalizeImages(finalHtml, url, assetDir, mode)：
     解析 <img> → data-src 修正 → 带 Referer 下载 → 存 assetDir/images/
     → 替换为 lume-file:// 绝对路径 → localizedHtml
  ▼
⑥ Readability + Turndown(localizedHtml) → markdown
     （此时 <img src=lume-file://> 被正确转为 Markdown 图片语法）
  ▼
⑦ 资产持久化：写 assetDir/index.md（正文 Markdown，图片为 lume-file 链接）
  ▼
⑧ 返回 { data: "<title>\n\n<markdown>\n\n---\nAsset: <assetDir>" }
```

> **关键顺序**：图片 URL 替换必须在 HTML→Markdown 转换**之前**完成（步骤 ⑤ 在 ⑥ 之前），
> Turndown 才能把 `<img src=lume-file://...>` 正确转为 Markdown 图片语法；若先 Turndown，
> Markdown 里已是纯文本链接无法回填，且 Readability 可能在转换时丢弃"非正文"图片。

## 6. 详细设计

### 6.1 `WebFetchTool` 改造（`packages/sdk/src/tools/web-fetch.ts`）

新增两个参数：

```jsonc
{
  "url": "string",
  "format": "markdown|text|html",          // 现有，默认 markdown
  "render": "auto|force|off",              // 新增，默认 "auto"
  "images": "download|keep|off"            // 新增，默认 "download"
}
```

- `render`：
  - `auto`（默认）：静态优先，按 `shouldRender` 判定是否回退渲染。
  - `force`：跳过静态，直接渲染（用于已知 SPA）。
  - `off`：纯静态，最快（向后兼容现有行为，但图片仍按 `images` 处理）。
- `images`：
  - `download`（默认）：下载到 `assetDir/images/`，Markdown 用 `lume-file://` 引用。
  - `keep`：仅做 `data-src` 修正 + 防盗链 Referer 提示，保留原始 URL，不下载。
  - `off`：完全不处理图片（现有行为）。

**标记重审**：
- `isReadOnly: true` → **改为 `false`**（图片落盘 + 写 `index.md` 有文件副作用）。
- `isConcurrencySafe`：改为**按模式判定**。
  - `render="off" && images="off"`：纯只读静态，仍并发安全。
  - 否则：非并发安全（渲染争抢单例窗口 / 资产目录写竞争）。
  - 实现时与 agent runtime 的并发模型对齐；保守默认整体 `false`，待 runtime 支持动态
    标记后再优化。

**返回值**：保持 `{ data: string, is_error?: boolean }`。`data` 为标题 + 正文 Markdown
（图片为 `lume-file://` 链接），尾部追加一行资产路径元信息 `[Asset: <assetDir>]`，供
agent 知道资产位置以复用。

**workspace 上下文**：`call(input, context)` 从 `context` 取 workspace slug（实现时确认
context 字段；若无则降级到默认 workspace），用于解析 `assetDir`。

### 6.2 资产包结构（D6 + D7）

```text
<getConfigDir()>/agent-workspaces/<slug>/resources/fetches/<fetchId>/
  ├─ index.md      # YAML frontmatter(source/fetched_at) + 原文 Markdown（图片 lume-file://）
  └─ images/       # 下载的图片，命名 = sha256(content).slice(0,16) + 原扩展名
```

- `fetchId`：`<urlHash8>`（同 URL 复用/覆盖，天然去重）。`urlHash = sha256(url).slice(0,8)`。
- `assetDir` 由 sidecar 的 `getWorkspaceResourcesPath(slug)` + `fetches/<fetchId>` 拼接，
  `ensureDir` 即用即建（沿用 `config-paths.ts` 约定）。
- 图片命名用内容 hash：跨抓取去重（同一张图多次出现只存一份），避免文件名冲突。
- `index.md` 图片引用 `lume-file://file/<encodeURIComponent(absPath)>`（absPath 必在
  `agent-workspaces` 可信根内，`resolveFileProtocolPath` 校验通过）。
- **`index.md` frontmatter**：顶部写 YAML frontmatter 记录来源元数据，正文跟在其后：

  ```yaml
  ---
  source: https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ   # 原始 URL（必填）
  fetched_at: 2026-07-09T12:34:56Z                            # 抓取时间，ISO 8601 UTC（必填）
  title: <Readability 抽出的标题>                              # 可选，顺带记录
  ---
  ```

  - `source`、`fetched_at` 必填；`title` 可选（Readability 已抽出，零成本）。
  - frontmatter 只写入资产文件 `index.md`；**返回给 agent 的 `data` 不含 frontmatter**
    （标题 + 正文 + 尾部 `[Asset: <dir>]`），避免占用上下文 token。

> 为什么 md 用 `lume-file://` 绝对路径而非相对路径：renderer 显示 Markdown 时，相对路径
> 需要额外解析基准目录；`lume-file://` 是 renderer 已支持的流式协议（CSP 已放行），直接
> 可显示。资产包迁移时的路径重写不在本期（YAGNI）。

### 6.3 渲染服务（`apps/desktop/src/`，main 进程）

新增 `PageRenderer`（仅一个实现：webContents），单例 + 请求队列串行化。

```text
PageRenderer
  - 单例隐藏 BrowserWindow（show:false，webPreferences: createSecureWebPreferences()，无 preload）
  - renderUrl(url, {timeoutMs, waitForSelector}): Promise<{html, finalUrl, status}>
      1. 入队（串行，同一时刻仅一个渲染）
      2. webContents.loadURL(url)
      3. 等渲染就绪：document.readyState==='complete' 且（waitForSelector 出现 或 网络空闲 ~2s）
      4. executeJavaScript(() => document.documentElement.outerHTML)  // 序列化渲染后 DOM
      5. 返回 { html, finalUrl: webContents.getURL(), status }
      6. 超时（默认 45s）→ reject；崩溃 → 重建窗口
```

- **导航白名单**：复用 `attachWebContentsSecurity`；`allowNavigation` 改为校验 sandbox
  `allowedDomains`（抓取目标是任意的，不是固定 weread 域）。
- **范式借鉴**：`wereadWindow`（`main.ts:626-659`）的 `loadURL` + `executeJavaScript` +
  单例生命周期骨架直接复用，改成隐藏窗口 + 程序化取 HTML。
- **安全**：渲染窗口无 preload、无 Node、无 Lume renderer IPC、无主窗口权限（与 weread
  一致）。渲染得到的 HTML 视为不可信内容。

### 6.4 reverse-RPC 通道（D5，核心架构新增）

现有 RPC 单向（main→sidecar 有 id 请求-响应；sidecar→main 只有无 id 通知）。新增一条
**sidecar 请求 → main 执行 → main 回调 sidecar** 的受控通道，仅服务渲染。

**协议**：

```text
1. sidecar: callMain("render:request", { url, options })
     - 生成 reqId
     - pending[reqId] = { resolve, reject, timer }
     - writeNotification({ method: "render:request", params: { reqId, url, options } })

2. main: 在 createSidecarHost 的 sidecar 消息处理处拦截
     - 检测 method === "render:request" 且 params.reqId 存在 → 不转发 renderer
     - 调 pageRenderer.renderUrl(url, options)
     - 完成后 sidecarHost.call("render:result", { reqId, html, finalUrl, status })
     - 失败时 sidecarHost.call("render:result", { reqId, error: { code, message } })

3. sidecar: 注册 render:result 的 RPC handler
     - 按 params.reqId 找 pending，resolve/reject 对应 promise
     - 返回 { ok: true }（handler 本身不承载业务结果，结果通过 resolve 传递）
```

- **改动点**：
  - `apps/sidecar/src/index.ts` / rpc 层：新增 `callMain(method, params)` 辅助 + `pending` map
    + `render:result` handler。
  - `apps/desktop/src/main.ts` `createSidecarHost`（约 `main.ts:810-853`）：消息处理新增
    `render:request` 拦截分支（在转发 renderer 之前）。
  - `apps/desktop/src/main.ts`：实例化 `PageRenderer`，handler 内调用。
- **非泛化**：此通道仅服务 `render:request`/`render:result` 两个 method。不做成通用
  sidecar→main RPC 注册表。未来其他 main 能力调用需求再单独设计（避免提前消耗）。
- **错误码**：`render_timeout`、`render_navigation_blocked`、`render_window_crashed`、
  `render_unavailable`（headless 无 Electron）。

### 6.5 渲染触发判定 `shouldRender`

判定基于 `rawHtml` 本身（轻量分析，不走 Readability），避免在判定阶段提前做 Turndown。

```text
shouldRender(rawHtml, mode):
  if mode === "off":    return false
  if mode === "force":  return true
  // mode === "auto"
  if isErrorShell(rawHtml):                  return false   // 403/404/空壳，渲染也救不回
  if hasSpaShell(rawHtml):                   return true    // <div id="app"/#root/__next> 且可见文本极少
  if bodyTextLength(rawHtml) < MIN_BODY_CHARS: return true   // 默认 200，疑似内容靠 JS 注入
  return false
```

- `bodyTextLength(rawHtml)`：剥离 `<script>/<style>` 后 `<body>` 纯文本长度（轻量正则，非
  Readability）。
- `hasSpaShell(rawHtml)`：检测常见 SPA 根挂载点（`<div id="app">`、`<div id="root">`、
  `<div id="__next">`）且 body 可见文本极少。
- `MIN_BODY_CHARS`：阈值常量（默认 200），可调。
- `isErrorShell`：检测错误页（标题含 403/404/not found、body 极短且无正文结构）。
- 判定只读 `rawHtml`；最终 HTML（raw 或 rendered）统一进入步骤 ⑤ 图片管线 →
  ⑥ Readability+Turndown，Readability 只跑一次。

### 6.6 图片管线 `downloadAndLocalizeImages`

输入：HTML（在步骤 ⑤ 对 `finalHtml` 操作，Turndown 之前；这样 `<img src=lume-file://>`
才能被 Turndown 正确转成 Markdown 图片语法）。

```text
downloadAndLocalizeImages(html, pageUrl, assetDir, mode):
  dom = JSDOM(html)
  for img in dom.querySelectorAll("img"):
    src = resolveImgSrc(img)          // 见下
    if !src: remove img; continue
    absUrl = new URL(src, pageUrl).href
    if mode === "download":
      try:
        blob = sdkFetch(absUrl, { headers: { Referer: originOf(pageUrl), User-Agent: <UA> } })
        ext = sniffExt(blob, absUrl)
        name = sha256(blob).slice(0,16) + ext
        write assetDir/images/<name>
        img.src = lumeFileUrl(join(assetDir, "images", name))   // lume-file://file/<enc>
        // 清掉 srcset/data-* 避免(renderer) 再请求远端
      catch: img.src = absUrl; img.dataset.fetchError = "download_failed"   // 降级保留原 URL
    else if mode === "keep":
      img.src = absUrl    // 仅修正，不下载
  return dom.serialize()

resolveImgSrc(img):
  // 懒加载兼容：src 为空/占位时，依次尝试 data-src / data-original / data-lazy-src / srcset
  return img.src || img.dataset.src || img.dataset.original
         || img.dataset.lazySrc || firstOfSrcset(img.srcset)
```

- **防盗链**：下载时 `Referer` = 文章页 origin（如 `https://mp.weixin.qq.com/`），UA 用
  与抓取一致的浏览器 UA。这是绕过 `mmbiz.qpic.cn` Referer 校验的关键。
- **lumeFileUrl**：复用 renderer 同款构造 `lume-file://file/<encodeURIComponent(absPath)>`
  （`apps/web/src/components/right-panel/file-preview-utils.ts:18-20`）。SDK 内需复制此构造
  函数（SDK 不依赖 web 包）。
- **去重**：内容 hash 命名，同图多次出现只存一份。
- **超时**：单图下载超时 15s，失败则降级保留原 URL，不阻断整体抓取。

### 6.7 安全与沙箱

- **域名沙箱**：`ensureNetworkAllowed`（`packages/sdk/src/utils/pathing.ts:94`）仍约束主抓取
  URL 与渲染目标。
- **图片资源域放宽**：图片域名（如 `mmbiz.qpic.cn`）通常不在文章页域名白名单内。规则：
  - 自动放行**与文章页同 origin** 的图片域。
  - 自动放行已知 CDN 白名单（初始含 `mmbiz.qpic.cn`、`mmbiz.qlogo.cn`；可配置扩展）。
  - 其余图片域仍受 `allowedDomains` 约束；不在白名单则该图降级保留原 URL（不下载）。
- **导航白名单（渲染窗口）**：渲染目标受 sandbox `allowedDomains` 约束；重定向到不允许
  目标则阻止（沿用 `electron-security.ts` 模式）。
- **不可信内容**：渲染 HTML、图片、Markdown 均视为不可信；不授予权限、不覆盖用户意图。

### 6.8 headless 降级

- sidecar 检测无 Electron parentPort（headless/CLI）时：`render` 强制视为 `off`，返回结果
  尾部标注 `[render unavailable in headless; static only]`。
- 图片下载、资产持久化在 headless 仍可用（纯 sidecar 能力，不依赖 main）。

## 7. 错误处理与降级

| 场景 | 处理 |
|---|---|
| 渲染超时 / 窗口崩溃 | 回退静态结果，尾部标注 `[render failed: <code>; static fallback]` |
| 反向 RPC 无响应（main 未拦截） | 超时后回退静态，记录诊断日志 |
| 单图下载失败（防盗链/超时/403） | 保留原始 URL，标注 `data-fetch-error`，不阻断 |
| Readability 失败（静态与渲染后都失败） | 回退正则去标签（现有 fallback，`web-fetch.ts:76-83`） |
| workspace slug 缺失 | 降级到默认 workspace 的 resources |
| 资产目录写失败 | 返回错误，不崩溃；Markdown 仍作为 data 返回（图片降级为原 URL） |

## 8. 测试策略

- **单元**（sidecar/sdk，bun:test）：
  - `resolveImgSrc`：`data-src` / `data-original` / `srcset` / 空.src 各分支。
  - `shouldRender`：空正文 / SPA 空壳 / 正常文章 / 错误页 边界。
  - `downloadAndLocalizeImages`：mock `sdkFetch`，验证 Referer 头、hash 命名、lume-file
    路径构造、失败降级。
  - `fetchId` / 资产路径拼接。
  - `index.md` frontmatter：验证 `source`/`fetched_at` 必填字段写入、ISO 8601 UTC 格式、
    返回给 agent 的 `data` 不含 frontmatter。
- **reverse-RPC 契约**：fake main（mock parentPort）验证 `render:request` 发出与
  `render:result` 回调 resolve 配对、超时、错误码。
- **Electron E2E**（desktop）：
  - 本地 fixture server 起一个 SPA 页（内容靠 JS 注入）+ 一个静态页，验证 `auto` 正确
    分支（SPA 触发渲染、静态不渲染）。
  - 验证渲染产物经 Readability 后正文正确。
  - 验证图片下载到 `assetDir/images/` 且 `index.md` 图片为 `lume-file://`、renderer 能显示。
- **冒烟（optional，需联网）**：针对 `mp.weixin.qq.com` 真实文章，验证正文 + 图片防盗链
  下载。标记为 optional，CI 不阻塞。

## 9. 完成条件

1. `WebFetch` 支持 `render`（auto/force/off）与 `images`（download/keep/off），默认
   `auto`/`download`。
2. `auto` 模式对 SPA 页正确回退渲染，对静态页不渲染。
3. 图片下载到资产目录，Markdown 用 `lume-file://` 引用，renderer 可显示；防盗链（mmbiz）
   正常下载。
4. 原文 Markdown 作为 `index.md`（顶部含 `source`/`fetched_at` frontmatter）与图片构成
   资产包，持久化到 `agent-workspaces/<slug>/resources/fetches/<fetchId>/`。
5. reverse-RPC 通道仅服务渲染，单一用途，不泛化。
6. `isReadOnly`/`isConcurrencySafe` 标记按副作用正确重审。
7. headless 场景优雅降级为纯静态 + 警告。
8. 单元 + reverse-RPC 契约 + Electron E2E 通过。

## 10. 风险

- **reverse-RPC 引入新通信模式**：main 新增"拦截 sidecar 通知执行 main 端动作"。需严格
  限定为 `render:request` 单一用途，避免演变为泛化 sidecar→main RPC（那是大设计范畴）。
  缓解：硬编码 method 匹配，不做注册表。
- **渲染窗口生命周期**：隐藏 `BrowserWindow` 崩溃/泄漏需由单一所有者管理，渲染完不释放
  窗口（复用），进程退出时销毁。
- **`isConcurrencySafe` 动态化**：现有 tool 框架标记是静态字段。若 runtime 不支持按 input
  动态判定，保守设 `false` 会损失 `render=off` 的并发性。需实现时确认 runtime 并发模型。
- **图片资源域白名单**：放宽图片域扩大网络面。缓解：仅同 origin + 显式 CDN 白名单，其余
  按现有 `allowedDomains`。
- **SPA 渲染就绪判定不稳**：`waitForSelector` / 网络空闲策略对各异站点可能不准。缓解：
  超时兜底 + 静态回退，不阻塞。

## 11. 关键文件清单

改动：
- `packages/sdk/src/tools/web-fetch.ts` — 工具参数、编排、标记重审
- `packages/sdk/src/tools/html-to-markdown.ts` — 复用（渲染后 HTML 也走它）
- `packages/sdk/src/tools/image-pipeline.ts` — **新增** `downloadAndLocalizeImages` /
  `resolveImgSrc` / `lumeFileUrl`
- `packages/sdk/src/tools/render-judge.ts` — **新增** `shouldRender`
- `packages/sdk/src/tools/desktop-render-client.ts` — **新增** `callMain` reverse-RPC 客户端
- `apps/sidecar/src/index.ts` / rpc 层 — `render:result` handler + `pending` map
- `apps/desktop/src/main.ts` — `createSidecarHost` 消息拦截 `render:request`；
  `PageRenderer` 实例化
- `apps/desktop/src/page-renderer.ts` — **新增** `PageRenderer`（webContents 实现）

参考（不改）：
- `apps/desktop/src/main.ts:626-659`（wereadWindow 范式）
- `apps/desktop/src/electron-security.ts:160-202`（`resolveFileProtocolPath` 可信根）
- `apps/sidecar/src/services/infra/config-paths.ts:160-162`（`getWorkspaceResourcesPath`）
- `apps/web/src/components/right-panel/file-preview-utils.ts:18-20`（`lumeFileUrl` 构造）
