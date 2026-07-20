# Plan: 完善插件市场缓存、界面、配套安装包与 Logo
_Locked via grill — by Codex + user_

## Goal

把当前统一的插件/技能市场改造成发现优先、可快速打开且信息一致的桌面应用商店：远程目录使用 30 分钟持久缓存和 stale-while-revalidate，强制同步时形成固定 Git commit 快照；插件声明的 Chrome、Obsidian 等配套安装包可在不安装 Lume 插件的前提下直接下载或导出；插件配置的 Logo 在市场卡片、详情页和输入框能力选择列表中一致展示。保留现有权限审查、插件安装/更新/启用、技能市场和市场源能力，不引入依赖，不自动向 Chrome/Obsidian 写入文件，也不执行第三方构建命令。

## Approach

1. **扩展统一市场协议，明确缓存、快照和配套包语义。**
   - 在 `packages/shared/src/types/plugin-market.ts` 扩展目录请求与响应：目录请求支持 `cache-first`（默认）和 `force-refresh`，响应携带 `status`、`syncedAt`、`expiresAt`、`refreshRecommended`、是否来自过期缓存及分源诊断；30 分钟 TTL 是 sidecar 常量，不写入用户配置。
   - 缓存只保存远程市场的静态快照：市场条目、已规范化的插件展示/权限/能力摘要、固定 source ref、资源元数据及诊断。安装状态、启用范围、回滚版本和本地技能状态每次请求都从 registry/state/config 重新叠加，禁止把 workspace 动态状态固化进缓存。
   - 保留现有 `marketplace.setup[].artifact` 与 `download` manifest 结构；每个 setup step 仍是一个可独立获取的包，展示名取 step title，版本取插件版本。`artifact.path` 支持受包根约束的文件或目录；`download.url` 只支持 HTTPS 文件。一个插件可声明多个配套包。
   - 为每个目录条目生成不依赖 `pluginId` 的 opaque `catalogItemKey`。远程键和映射持久化在 snapshot generation 中，绑定 source identity、item kind、entry id 和 generation；目录响应同时返回短时 `catalogViewLeaseId`。详情、权限确认、安装、市场驱动更新、Logo 与配套包都使用该键并续租，Web 离开市场时尽力 release，异常退出由 TTL 回收。generation 在 view/operation lease 存活时不得清理；若旧键已过期，返回 typed `snapshot_expired` 并让 Web 无损重载目录。
   - 本地 market entry 和 installed-only plugin 不伪造 snapshot：使用 `sha256(canonical source identity + kind + entry/plugin id + current local fingerprint)` 生成不泄露绝对路径的稳定 opaque key。local fingerprint 包含规范 realpath identity、market/plugin manifest 内容 hash，以及 installed record 的 active version；解析时从当前有效本地源/registry 重算并匹配，所以 restart 后稳定，路径、manifest 或 active version 变化后旧键必然失效并返回 typed `local_item_changed`，触发目录重载。本地键不需要持久化 path mapping，也不受远程 generation cleanup 影响。
   - 不同来源的同名/同 pluginId 条目不再被 `byId` 静默覆盖，安装状态仍按 pluginId 叠加并明确显示来源冲突。市场驱动更新必须传 `catalogItemKey + acceptedPermissionsHash`；现有只按 installed record/pluginId source 更新的 API 保留为明确分开的“从已安装来源更新”，不得在市场详情中混用。
   - 新增按 `workspaceSlug + catalogItemKey + setupStepId` 准备配套包的共享类型，但不把 prepare/finalize/revoke 注册成 renderer 可任意转发的普通 `sidecar_call`。renderer 不提交 URL、插件 ID、版本、相对路径或目标绝对路径；结果只包含不透明、短时、一次性的 package token，以及类型、建议文件名、版本、大小、来源和校验状态，不暴露 sidecar 临时绝对路径。
   - 新增配套包准备进度事件，至少包含 operation ID、阶段和在 `Content-Length` 可用时的 downloaded/total bytes；UI 在无法计算百分比时显示明确的阶段型进度。

2. **实现持久市场快照与不阻塞首屏的 stale-while-revalidate。**
   - 在现有插件缓存目录下增加版本化 market snapshot 子目录，按规范化 source identity（source id、kind、URL/path）隔离。每次写入不可变 generation 文件：写临时文件、flush/fsync 内容、关闭、改为唯一 generation 名、再写并 fsync 含内容 hash 的 complete marker，平台支持时同步父目录；任一步失败都不发布。reader 必须同时校验 marker、identity/schema 和每个内容 hash，部分写入一律忽略。小型 current pointer 仅作优化，损坏时扫描 generation 恢复，不依赖 Windows 上覆盖 rename 的原子性。
   - `cache-first` 有新鲜缓存时立即返回；有过期缓存时立即返回旧快照并标记 stale；无缓存时等待一次远程同步。Web 首屏拿到 `refreshRecommended` 后发起一次 `force-refresh`，旧数据保持可交互，刷新完成再原位更新，不回到全屏 loading。
   - `force-refresh` 绕过 TTL，但相同 source 的并发刷新由进程级 promise 合并；持久发布/清理由现有跨进程 mutation lock 或等价 lock 保护，不可变 generation 允许失败恢复。清理至少保留当前和上一成功 generation，并跳过被详情、安装、Logo 或配套包 operation lease 引用的 generation。
   - 每次 refresh 捕获 source identity/generation token，并在发布前重新读取有效配置；来源已移除、禁用或 URL/path 已变化时丢弃结果，不能复活旧来源。单个市场源失败时保留最近成功快照，其他源继续；响应给出每源 `fresh | stale | failed` 终态和聚合 `fresh | partial | failed-with-stale | failed`，手动同步不得把旧数据误报为同步成功。结构化日志记录 operation ID、source/generation、时长、请求/下载字节、cache outcome 和失败分类，不记录包内容或 token。
   - GitHub market root 的默认分支/branch/tag 解析为具体 commit SHA；该次快照中的索引、插件与技能 source、manifest、README、Logo、Lume 插件安装和配套包获取全部引用同一个 SHA。`skill-github` 在快照中改写为含 commit 的固定 URL/ref，技能详情与安装也消费该固定来源。
   - 对现有任意 `.json` 远程索引，快照固定保存索引原始字节/hash；其中每个 GitHub plugin/skill source 再独立把 ref 解析为 commit。远程索引中的 `local`/`legacy` 来源或无法固定的远程来源直接诊断并跳过，不能借远程 JSON 读取用户机器任意路径。仅下一次成功强制同步才能切换快照内容。
   - 刷新时用小型无依赖并发池并行检查插件（建议并发 4），避免当前逐插件串行 GitHub tree + manifest 请求；对同一 repo/commit 的 tree、raw 文本和资源请求在本轮内去重。设置连接/读取超时、响应大小上限和清晰诊断，避免一个条目无限拖住全源。
   - 本地市场源和已安装插件继续实时读取；本地 I/O 不走 30 分钟远程 TTL。新增/移除/启停市场源后使对应 source snapshot 失效；安装、更新、卸载和启用操作只刷新动态 overlay，无需丢弃远程静态快照。

3. **让详情、安装和下载都消费同一固定快照。**
   - `PluginMarketService` 按 source/item 查找固定快照，详情和 README 优先使用快照中的 pinned source；已安装的纯本地插件仍按本地来源读取。
   - Lume 插件安装/更新前必须重新从快照记录的 commit SHA 读取并规范化实际 manifest、重新计算权限 hash，并与用户确认的 hash 匹配；缓存只加速发现，不成为权限或安装内容的信任来源。
   - 配套包准备同样只接受快照中存在的 setup step。包内 artifact 从本地包根或 pinned GitHub tarball 中精确提取声明的文件/目录，绝不把整个仓库误当作配套安装包；路径解析执行 realpath/containment、符号链接与目录穿越检查。
   - 建立一个复用 Node 内置 `https.request` 的统一受控远程读取器，远程 market JSON、GitHub API/raw/tarball、README、Logo 和 `download.url` 全部经它访问，不再使用不受约束的 `fetchText`。每次连接和重定向都解析 DNS、拒绝 loopback/RFC1918/link-local/multicast/保留 IPv4/IPv6 和 metadata 地址，并用自定义 lookup 固定本次已校验地址，防止 DNS rebinding；按资源类型限制 allowlist/HTTPS、重定向、连接/读取超时和响应/下载大小。外部包流式写入隔离区，不整包读入内存。
   - “官方”只由代码内建的官方 source provenance/canonical URL 标记产生，不信任用户可配的 id/name。官方外部包缺少 SHA-256 时禁止准备；配置 hash 时边下载边校验，不匹配即删除并失败。非官方未配置 hash 时也只下载一次到 quarantine，计算实际 SHA-256、大小和最终 origin 后返回 `unverified` token；用户确认授权的是该确切 token/字节序列，而不是可再次变化的 URL。跨 origin redirect 明示最终 origin，并在不属于来源 allowlist 时要求额外确认。
   - 所有 manifest 控制的 filename/artifact basename 在进入 token 前只取 basename，经过跨平台安全字符、长度、扩展名、控制字符和 Windows 保留设备名校验；后续保存只使用 token 中的已验证名称。
   - 包内 artifact 以固定 commit 快照作为内容版本依据；不执行 `build.command`。构建命令仍只显示为说明并通过 `writeClipboardText` 复制。

4. **以受控临时包和原生保存对话框完成直接下载/导出。**
   - 重构 `PluginBridgeService`，删除“只能从 `~/.lume/plugins/<id>/<version>` 导出”的前提以及 renderer 可传任意 path/URL 的入口；确认无其他调用者后删除旧 `EXPORT_PLUGIN_ARTIFACT`/`DOWNLOAD_BRIDGE_ASSET` 公共协议，而不是保留可绕过约束的兼容后门。
   - 包内远程 artifact 复用现有系统 `tar` 路径：先完整 list archive，限制 entry 数、声明/展开体积与规范化路径，拒绝 absolute/`..`、symlink、hardlink、device 和其他特殊项，再在全新临时根提取；提取后再次 no-follow 扫描路径、文件数和总字节，只复制声明 artifact。任何校验失败都删除临时根。
   - sidecar 将准备好的单文件或目录保存在专用临时根，登记 package token、owner webContents/session generation、source snapshot lease、kind、validated name、hash、创建时间和状态。状态通过原子 `preparing → ready → consuming → consumed/revoked` 转换；并发消费被拒绝，成功不可重放，保存失败且目标已安全回滚时最多恢复为 ready 供有限重试，取消/过期直接 revoke。
   - package prepare/save/revoke 都走受 Electron allowlist 保护的专用 desktop command：main 注入可信 owner webContents ID/generation 后调用 sidecar 私有方法。把 renderer 的通用 `sidecar_call` 从任意 method 转发改成集中维护的显式 public-method allowlist；未知方法和全部 main-only package method 默认拒绝，未来新增 private method 不需要依赖 denylist 记忆。token 必须匹配发起窗口及当前 generation。
   - Electron main 从 sidecar 查询 token 的可信 kind/建议名；文件使用 `showSaveDialog`，目录使用 `showOpenDialog` 选择父目录，并在目标目录已存在时显式确认“完整替换”而非合并。取消后 main 调用幂等 revoke，立即清理 prepared package。
   - 用户确认后，Electron main 把自己选择的目标路径传给 sidecar 私有 finalize。目录先在目标同级临时路径完整 staging，no-follow 重验目标；覆盖时把旧目录原子改名为 backup，再切换新目录，成功后删除 backup，失败则回滚。无法保证同卷安全替换时宁可失败，不做有 stale 文件的递归 merge。完成后返回保存路径，UI 提供“打开所在文件夹”。
   - preparation 使用 AbortController、全局 2 个/每源 1 个并发槽、单包下载和展开上限、临时总字节配额；能读取 `Content-Length` 时先做 admission check。窗口销毁、用户取消、超时和 sidecar shutdown 都中止下载并幂等清理；配额/并发拒绝返回可解释诊断。
   - 下载/导出不隐式调用 `installMarketItem`。详情页中的“安装 Lume 插件”和“下载 Chrome 扩展 / 导出 Obsidian 插件”等动作彼此独立；浏览器授权、配对码、目标应用提示和状态检测继续留在后续安装引导中。

5. **完整解析并复用插件 Logo。**
   - `marketplace.icon` 继续只接受插件包内相对路径，不新增任意外链 Logo；支持现有允许的 PNG/JPEG/WebP/GIF/SVG 类型和体积上限，拒绝越界路径、不支持的 MIME、过大或读取失败的资源。
   - 本地/已安装插件从受约束的包路径读取；远程插件从 snapshot 的 commit SHA、subdir 和 icon path 构造 raw 资源请求，将二进制放入 market asset cache。校验扩展名、响应 MIME 与 magic bytes 一致。由于本期不新增成熟 SVG sanitizer/光栅化依赖，远程 SVG 一律不提供给 renderer并回退占位图；可信本地包内 SVG 保持现有 `<img>` 展示。市场作者若希望安装前展示 Logo，需提供 PNG/JPEG/WebP/GIF。
   - 公共目录只返回 opaque `assetId`，不重复内嵌 data URL。Web 通过绑定 webContents/generation 的 desktop asset-scope API 获取受限 `lume-file`/专用协议 URL；Electron 响应设置准确 MIME、`nosniff`、禁缓存外泄和 `default-src 'none'` 等限制，scope 销毁/窗口 reload 时撤销。资源缓存与 source generation 一起失效，失败不阻断目录。
   - 在 Web 增加一个小型共享 `PluginLogo` 展示组件，统一 `object-contain`、尺寸、圆角、加载失败回退和无障碍文本；市场卡片、插件详情以及能力选择列表复用它，不再各自实现不同的 `<img>`/Puzzle 分支。
   - sidecar 的 invocable capability catalog 继续让插件及其 `plugin-skill` 继承父插件 Logo；修正 Web mention/slash 映射，使任何带 `iconUrl` 的插件能力或插件子技能都优先显示 Logo，而不是因为被映射成 `skill` 类型而回退到 Book 图标。

6. **把统一市场重设计为发现优先的桌面应用商店。**
   - 保留 `SkillsMarketView` 作为统一入口，但把页面重组为：顶部插件/技能切换、搜索和同步状态；次级“全部 / 已安装 / 可更新”状态筛选与来源/分类筛选；下方响应式卡片网格。使用现有主题变量和 `apps/web/src/components/ui` 的 Button、Input、Select、Dialog/Sheet、Badge、Tabs 等原子组件，不引入视觉依赖。
   - 卡片以真实 Logo、名称、短描述、版本、来源、状态和单一主操作为核心。含配套包的插件显示 Chrome/Obsidian 等克制标签，但不在卡片堆叠多个下载按钮；点击标签或卡片进入详情。
   - 市场源列表和现有添加来源流程移入独立对话框/抽屉，移除常驻右栏，为发现区让出宽度；本期只迁移既有来源行为，不扩张到评分、发布、审核后台等新功能。
   - 目录首次无缓存时显示 skeleton/loading；命中缓存立即展示。后台刷新只在页头显示状态；失败时保留内容并展示“使用上次成功数据/可能已过期”的非阻塞提示。上次同步时间使用 sidecar 返回的真实 `syncedAt`，不再用 renderer 请求完成时间伪装。
   - 插件详情首屏显示统一 Logo、安装/启用状态、独立的“安装 Lume 插件”主操作，以及每个配套包的类型、名称、版本、校验状态和直接下载/导出按钮；README、权限、诊断和非下载 setup 步骤保留在分区/Tabs 中。技能详情采用相同页面层级，但不强行添加插件专属信息。
   - 桌面应用商店风格保持紧凑、低装饰、卡片等高，并验证浅色/深色和常见窗口宽度。纯样式与文案不为仪式感增加测试。

7. **补齐定向测试与回归保护。**
   - Sidecar：覆盖 cache hit/miss/expired/force refresh、并发刷新合并、跨进程 writer、模拟各 fsync/rename/marker 阶段崩溃与重启、损坏 pointer/generation、分源 stale fallback、refresh 后来源被删除/改址、动态安装状态不被缓存、GitHub plugin/skill 固定到 commit、任意 JSON 索引 bytes 固定、所有远程资源走受控读取器、远程 local source 拒绝、重复 pluginId 的 source/item identity、market update key、remote catalog lease/重启/过期重载、local/installed key 跨重启稳定与 manifest/path/active-version 变化失效、同快照详情/Logo/安装包一致及 generation lease 清理。
   - 配套包：覆盖未安装插件直接获取、精确文件与目录导出、多包、archive bomb/路径穿越/符号与硬链接、SSRF 私网/IPv6/metadata/DNS rebinding、跨 origin redirect、超时/大小和临时配额、流式 SHA-256、官方 provenance/缺 hash 阻断、非官方确认绑定具体 bytes、unsafe filename、一次性 token 原子并发、owner 窗口绑定、取消/过期/重复消费和不执行 build command。
   - Shared/SDK：保留并扩展 manifest 与 RPC schema 测试，证明旧的合法 `artifact/download/icon` 配置仍可解析，非法相对路径、协议、类型继续被拒绝。
   - Web：扩展纯状态测试覆盖状态筛选、缓存状态文案、卡片 Logo/回退、插件子技能 Logo、安装与配套包动作互不触发；更新现有市场/详情/BridgeInstallWizard 契约测试，只为变更的可测试逻辑添加断言。
   - Desktop：覆盖新 invoke allowlist、`sidecar_call` 无法直达私有 package methods、跨窗口/token generation 拒绝、文件/目录对话框分支、取消 revoke、目录整包替换与失败回滚、main 到 sidecar finalize 的可信目标传递和完成后 reveal。
   - 只运行上述相关测试与受公共类型影响模块的必要 typecheck，最后执行 `git diff --check`；手工验证一次冷启动无缓存、缓存命中、过期后台刷新、强制同步、Chrome 文件包、Obsidian 目录包、未校验外链包和三处 Logo 展示。

## Key decisions & tradeoffs

- 统一改造插件与技能市场外壳，但安装包、权限和插件 Logo 继承只属于插件侧，避免复制两套市场页面。
- 远程缓存固定为持久化 30 分钟 TTL + stale-while-revalidate；旧数据优先保证可用性，强制同步负责新鲜度。缓存不包含 workspace 动态状态。
- 每次同步固定到 Git commit SHA，牺牲 branch 实时性，换取列表、权限、Logo、Lume 插件和配套包内容一致。
- 目录条目以 source/item/snapshot generation 为身份，不再用 pluginId 去重；同 pluginId 多来源会显式呈现冲突，而不会静默选错详情或安装包。
- “直接下载/导出”表示不先安装 Lume 插件、不进入多步 setup；仍通过一次原生保存确认保护目标路径和覆盖行为。
- Lume 插件安装与配套包获取是两个独立动作；同一插件可以同时提供两者。
- 包内文件原样保存，包内目录原样导出为目录，不统一压缩为 ZIP；外部 URL 仅交付单文件。
- 官方外部包必须带 SHA-256；非官方无 hash 可在明确警告后下载。这比全部阻断更兼容自定义市场，同时保留风险可见性。
- 未校验确认绑定已下载 quarantine 中的具体 hash/size/final origin；不会在用户确认后重新请求可变 URL。
- `marketplace.icon` 保持包内相对路径，不增加任意 Logo URL；插件子技能继承父 Logo。
- 自动安装到 Chrome/Obsidian、自动执行 build command 均不做；避免扩大系统写入、Vault 选择和第三方命令执行边界。
- 不增加依赖；复用现有 shadcn/global 组件、配置路径、GitHub 获取逻辑、clipboard IPC 和 Electron 原生对话框。

## Risks / open questions

- 首次无缓存仍需读取完整远程目录；通过并发池、请求去重、超时和分源容错降低等待，但不能消除网络成本。
- GitHub 未认证 API 仍可能限流；过期缓存可继续使用，但首次启动且无缓存时只能给出清晰错误。实现应复用现有降级逻辑，不能伪造新鲜数据。
- 多 sidecar/应用实例可能竞争同一缓存；不可变 generation、跨进程 lock、complete marker 和 operation lease 必须共同保证旧快照始终可读且活跃 generation 不被清理。
- 目录 artifact 的远程提取需要下载 pinned repo tarball，体积可能明显大于最终包；必须应用临时空间、下载大小和清理限制。
- 非官方、无 SHA-256 的外部包仍存在供应链风险；UI 必须保持警告，不能把 `unverified` 表述为安全。
- Logo 通过绑定窗口 generation 的 scoped protocol 交付；scope 撤销、CSP/MIME 隔离或 asset generation 过期都可能触发安全回退。远程 SVG 本期明确不显示，不能让资源失败成为市场加载的硬依赖。
- 原生保存流程跨 renderer、main、sidecar，token 生命周期、取消和 sidecar 重启需要严格测试，避免残留临时文件或把任意目标路径重新暴露给 renderer。
- 当前工作树已有与本任务无关的用户改动；实施时必须只触碰本计划列出的市场相关文件，并在重叠文件中保留现有修改。

## Out of scope

- 自动把扩展写入 Chrome、自动定位或修改 Obsidian Vault、系统级静默安装。
- 自动执行 `marketplace.setup.build.command`、构建第三方源码或引入打包依赖。
- 插件评分、评论、排行榜、推荐算法、开发者发布后台、签名基础设施和远程审核服务。
- 支持任意外链 Logo、为未配置 Logo 的插件抓取网站 favicon，或重新设计全局聊天输入框。
- 改变插件运行时权限模型、MCP/Hook/Skill 执行语义或现有插件配置格式。
- 为纯视觉改动补全量快照测试，或运行全仓 lint/typecheck/test。
