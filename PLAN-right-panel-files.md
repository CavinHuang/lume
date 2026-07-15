# Plan: 重设计当前会话右侧文件面板与文件树
_Locked via grill — by Codex + user_

> 实施时按任务顺序推进；产品代码动手前先复核本计划与 `AGENTS.md`。不新增依赖，新增/改造的交互控件复用 `apps/web/src/components/ui` 原子组件。

## Goal

把当前右侧“文件”功能从拥挤的单文件预览页重构为紧凑、稳定的会话级文件工作区：用统一资源树承载项目文件、会话文件、记忆源文件和旧版资源；在窄面板中以浏览与操作为主，在宽面板中使用左树右预览；多个文件作为右侧顶层 Tab 打开，切换文件 Tab 时只重读预览内容，绝不重建或刷新共享文件树。

## Approach

### 1. 先拆分持久状态与本次运行状态，建立可测试的文件工作区模型

**涉及文件**

- 修改 `apps/web/src/atoms/right-panel-atoms.ts`
- 修改 `apps/web/src/components/right-panel/right-panel-state.ts`
- 修改 `apps/web/src/components/right-panel/right-panel-state.test.ts`
- 新建 `apps/web/src/components/right-panel/right-panel-files-state.ts`
- 新建 `apps/web/src/components/right-panel/right-panel-files-state.test.ts`

**实施内容**

- 保留现有 `rightPanelWorkspacesAtom` 负责可持久化的功能 Tab（审查、终端、浏览器、文件入口）与面板布局；从持久化的 `FilesTabState` 中移除 `selectedPath`、搜索词、展开节点等瞬时文件导航状态。
- 新增普通 Jotai `atom`（不得使用 `atomWithStorage`），按 `threadId` 保存本次应用运行内的 `ThreadFileWorkspace`：
  - 统一来源 `project | session | memory | legacy`；
  - 当前选择、临时预览、来源分组与目录展开集合；
  - 已加载目录缓存、滚动锚点、搜索状态、详情栏折叠状态；
  - `openTabs: RightPanelFileTab[]`、文件 Tab 顺序、当前文件 Tab ID；
  - 各来源 `fresh | stale | loading | error` 状态。
- 新增统一、判别明确的运行态激活项 `RightPanelActiveItem = { kind: 'function'; type: RightPanelFunction } | { kind: 'file'; tabId: string }`；通过一个 Jotai write atom 原子更新运行态激活项和持久功能 Tab 是否存在，禁止让 persisted `activeTab` 与文件激活态各自为真。关闭当前“文件”入口时若仍有具体文件 Tab，激活最近文件；关闭最后一个文件 Tab 时回退到仍存在的功能 Tab。
- 在 shared/web 契约中定义 opaque `FileRef = { source, scopeId, relativePath }`。列表、搜索、预览、Tab、mutation 全部传 `FileRef`，不得混用当前列表绝对路径和搜索相对路径；`relativePath` 由服务端统一 `/` 分隔、去除 `.` 段并在 Windows 做大小写身份归一，展示路径与身份键分离。
- 文件 Tab 的稳定键使用归一化后的 `source + scopeId + relativePath`。同一引用再次打开时只激活已有 Tab；不同来源或 scope 即使路径文本相同也视为不同文件。
- 写纯函数覆盖：打开/复用/关闭文件 Tab、关闭“文件”入口但保留文件 Tab、同名文件的最短父目录消歧、重命名/移动后的路径批量重写、删除文件或目录后关闭受影响 Tab。
- 应用重启不恢复具体文件 Tab、树展开状态、选中项、搜索词或滚动位置；同一次运行切换会话再回来时按 `threadId` 保留；用户关闭的 Tab 不自动恢复。仅右侧面板宽度和用户拖动后的树宽继续长期保存。
- 树宽写入独立的 `rightPanelFileLayoutPreferencesAtom`（storage），不得挂在可关闭的 Files Tab state 上；关闭并重新打开“文件”入口仍保留宽度。
- 增加 thread lifecycle reconciliation：`agentThreadsAtom` 中线程消失时删除对应运行态并撤销全部 preview scope；线程 `workspaceId/fileContextId` 换绑时保留仍指向同一 fileContext 的 session Tab，关闭并撤销旧 project/memory/legacy Tab，清空受影响来源缓存并修正 active item。不得让已删除或已换绑线程的 scope 留在内存中。

**验证**

- 相关测试明确证明：文件 Tab 不进入 storage state；统一 active item 不产生双活；相同 `FileRef` 不重复且 Windows 路径身份稳定；关闭入口不级联；目录路径重写覆盖所有后代；删除目录关闭所有后代 Tab；线程删除清理运行态与 scope；换绑只保留仍授权的 session Tab；重启用空的运行态开始；树宽独立持久化。
- 运行 `bun test apps/web/src/components/right-panel/right-panel-state.test.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts`，预期全部通过。

### 2. 把右侧顶层 Tab 栏升级为功能 Tab 与文件 Tab 的共同容器

**涉及文件**

- 修改 `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
- 修改 `apps/web/src/components/right-panel/RightPanelTabBar.test.ts`
- 修改 `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- 修改 `apps/web/src/components/agent/AgentView.tsx`
- 修改 `apps/web/src/components/agent/AgentView.test.tsx`
- 修改 `apps/web/src/components/agent/AgentAttachmentGrid.tsx`
- 修改 `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- 修改 `apps/web/src/components/agent/tool-result-renderers/image-gen-result.tsx`
- 修改相关 attachment/runtime-event/memory shared types 与上述组件现有测试

**实施内容**

- 将 Tab 栏输入改为统一的可渲染条目：功能 Tab 保持现有语义，文件 Tab 跟随“文件”入口排列并保持打开顺序。
- “文件”入口和每个具体文件 Tab 都可独立关闭；关闭入口不关闭具体文件 Tab，关闭文件 Tab 不清空共享树状态。通过加号菜单可重新打开“文件”入口。
- 文件 Tab 显示文件类型图标和 basename；同名时追加最短可区分父路径；完整来源与路径放入 tooltip。
- Tab 栏高度从 44px 压缩到 36px。空间不足时横向滚动，滚轮转换为横向滚动，激活项自动滚入可视区；增加使用现有 Popover/Dropdown 原子的“全部 Tab”菜单。关闭按钮仅在激活或悬浮时出现，并支持中键关闭。
- 修改 `openFileInRightPanel` 的调用路径：来自消息、附件或记忆引用的文件直接创建/复用顶层文件 Tab，不再把单个 `selectedPath` 写进持久 `FilesTabState`。
- 枚举所有深链生产者：保存后的 attachment `threadPath`、历史消息附件、runtime event 工具结果/图片、memory citation/sourcePath、旧 `openFileInRightPanel(path, source)` 调用。新记录直接携带服务端签发的 `FileRef`；旧记录通过只接受 `{recordKind, threadId/workspaceSlug, legacyRelativePath 或 memory source id}` 的 authorized conversion RPC 转换，禁止 renderer 把任意绝对 `sourcePath` 拼成 `FileRef`。本地待上传附件的 `sourcePath` 保留为上传输入，但不得进入右侧文件深链。
- 激活项属于文件工作区时，`RightPanelWorkspace` 始终复用同一个文件工作区外壳；在具体文件 Tab 之间切换只改变预览目标。切换到浏览器等非文件功能后可以卸载文件外壳，但运行态数据仍保留。

**验证**

- 测试功能 Tab 与文件 Tab 的顺序、独立关闭、中键关闭、同名消歧、重复打开复用、新旧 attachment/runtime-event/memory 深链转换，以及 renderer 绝对路径不能创建授权 FileRef。
- 运行 `bun test apps/web/src/components/right-panel/RightPanelTabBar.test.ts apps/web/src/components/agent/AgentView.test.tsx apps/web/src/components/right-panel/right-panel-files-state.test.ts`，预期全部通过。

### 3. 扩充只读列表元数据与跨来源搜索契约

**涉及文件**

- 修改 `packages/shared/src/types/agent.ts`
- 修改 `apps/sidecar/src/rpc/schemas.ts`
- 修改 `apps/sidecar/src/rpc/agent-handlers.ts`
- 修改 `apps/sidecar/src/services/agent/agent-files-service.ts`
- 修改 `apps/sidecar/src/rpc/agent-handlers.files.test.ts`
- 修改或新增 `apps/sidecar/src/services/agent/agent-files-service.test.ts`

**实施内容**

- 以向后兼容的可选字段扩展 `FileEntry`：`ref: FileRef`、`size`、`modifiedAt`。绝对路径不再作为前端身份或新接口输入；文件列表时用一次 `lstat/stat` 填充 metadata，单项失败降级为无 metadata。目录不递归统计后代，直接子项数量只在对应目录已加载后由前端得出。
- 保留项目目录只读契约，不增加项目重命名、移动、删除或保存 RPC。
- 新增共享的服务端 `resolveAuthorizedFileRef`：按 `source/scopeId` 解析 canonical root，对 list/read/stat/search/open/preview/rename/move/delete/legacy-export 的现有目标及每级祖先执行 `lstat` 和 realpath 边界校验；目录遍历不跟随 symlink/junction/reparse point，现有 session/legacy 仅做 lexical containment 的路径不得直接复用。
- 将当前只服务会话目录、同步递归且最多五层的搜索实现收口为可复用的异步目录搜索器；不得跟随符号链接，不阻塞 sidecar 主循环。前端 200ms debounce；每个 `{source, scopeId}` 只允许一个活动扫描，新 query 通过 request id/AbortController 取消旧扫描；sidecar 设置并发与扫描条目/耗时预算。返回最多 200 个结果、`truncated` 和已扫描匹配数，不承诺预算截断时的精确总数。
- 会话文件复用/扩展现有 `SEARCH_WORKSPACE_FILES`；新增边界明确的项目文件搜索与旧版资源搜索 channel。所有路径先经过各自现有的安全根解析器。
- 默认跳过 `.git`、`node_modules`、`.venv`、`dist`、`build`、`.next`、`coverage`、缓存目录等高噪声目录，但包含普通目录中的点文件；`includeExcluded=true` 时进行一次性完整扫描。
- 记忆源文件不能依赖 `getMemorySettingsSnapshot` 的摘要子集。新增分页 `LIST_MEMORY_SOURCE_FILES`，覆盖工作区与全局 memory/daily/run 源文件，返回 `FileRef`、更新时间与 cursor；搜索复用这份完整列表。旧版资源默认不参与统一搜索，只有用户显式启用后才调用其搜索 channel。
- 现有 Lume 工作区文件变化事件只用于把 `session/legacy` 来源标为 stale；新增 memory-specific change event，监听工作区与全局记忆根并把 `memory` 标为 stale。本轮不增加真实项目目录 watcher，也不在收到事件时自动刷新树。

**验证**

- 测试点文件可搜索、默认排除噪声目录、显式包含排除目录、旧请求取消、扫描预算与 `truncated`、符号链接/Windows junction 不跟随、四种来源边界不可逃逸、`FileRef` 归一、200 条上限、metadata 字段、memory 分页与全局变更事件。
- 运行 `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts apps/sidecar/src/rpc/agent-handlers.files.test.ts`，预期全部通过。
- 运行 `bun run --filter @lume/shared typecheck && bun run --filter @lume/sidecar typecheck`，预期退出码 0。

### 4. 用一个统一资源树替换右侧面板里的来源切换器和重复树实例

**涉及文件**

- 新建 `apps/web/src/components/right-panel/UnifiedFileTree.tsx`
- 新建 `apps/web/src/components/right-panel/unified-file-tree-state.ts`
- 新建 `apps/web/src/components/right-panel/unified-file-tree-state.test.ts`
- 修改 `apps/web/src/components/right-panel/FilesRightPanelTab.tsx`，最终将其缩减为文件工作区外壳或用新的外壳替换
- 保留 `apps/web/src/components/file-browser/FileBrowser.tsx` 与 `WorkspaceFileBrowser.tsx` 给 Agent 旧侧栏、设置页和主区域文件预览使用；本轮不顺手重构这些调用方

**实施内容**

- 删除右侧文件页当前“项目目录 / Lume 工作目录 / 旧版资源”的 segmented source switch，改为同一棵树中的四个顶层分组，顺序固定：
  1. 项目文件：默认展开，不显示递归总数；
  2. 会话文件：默认展开，显示当前已知文件数量，空时保留简短空状态；
  3. 记忆：默认折叠，内部仅显示“工作区记忆 / 全局记忆”真实源文件与现有快照数量；
  4. 旧版资源：仅有内容时出现，默认折叠，显示已有条目数量。
- 项目、记忆、旧版资源只读；会话文件允许重命名、通过菜单选择目标目录移动、递归删除。旧版资源保留单项“导出到项目”且不覆盖同名内容；不增加批量迁移。
- 统一树行高 28px、图标 14px、每层缩进 12px，使用细层级引导线。来源标题约 30px。悬浮或选中时才显示行内操作，不使用卡片式大间距。
- 工具栏压缩到 36–40px，包含搜索、刷新当前来源/全部、全部折叠、更多；所有 button/input/menu/dialog 必须复用 `apps/web/src/components/ui`。
- 单击只选中；双击或 Enter 打开/复用顶层文件 Tab；Space 临时预览。目录单击按选中处理，展开箭头与键盘左右键负责展开/折叠，避免点击整行时误切状态。
- 实现完整 roving-focus 树键盘模型：上下、左右、Home/End、Enter、Space、F2、Delete、Ctrl/Cmd+C、Ctrl/Cmd+F、Esc。右键菜单与快捷键调用同一能力判定，禁用项说明原因。
- 搜索输入后显示按来源分组的结果视图；清空时恢复搜索前的展开集合、选择和滚动锚点。默认搜索项目、会话、记忆；旧版需显式加入。结果显示文件名、相对路径、已返回数量，以及扫描被预算截断时的明确提示；不得把部分扫描伪装成精确总数。
- 每个可写来源建立串行 mutation queue；目录缓存带 generation。面板内重命名、移动、删除响应只有在 generation 未变化时才局部更新缓存；若操作期间收到 stale 事件、另一 mutation 或父目录 reload，则成功后重新加载受影响父目录，不把响应套到过期树。失败不修改树或 Tab。Lume 来源 stale 时只显示“有更新”提示，用户刷新后重新读取并恢复仍存在的展开节点、选择和滚动位置。
- 不实现新建文件/目录、树内拖拽移动、系统拖入、拖到输入框、全文内容搜索、排序设置或 Git 状态。

**验证**

- 纯状态测试覆盖分组可见性、默认展开、展开恢复、搜索进入/退出、stale 标记、权限矩阵、mutation 串行化、generation 一致时局部更新与 generation 失配时 reload。
- 对涉及可测试交互逻辑的组件补充现有 Bun/React SSR 风格测试；不为纯 CSS 密度写脆弱快照。
- 运行 `bun test apps/web/src/components/right-panel/unified-file-tree-state.test.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts`，预期全部通过。

### 5. 建立自适应文件工作区布局，并保证文件树实例稳定

**涉及文件**

- 修改 `apps/web/src/components/right-panel/right-panel-layout.ts`
- 修改 `apps/web/src/components/right-panel/right-panel-layout.test.ts`
- 新建 `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`
- 修改 `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`

**实施内容**

- 使用文件工作区容器宽度作为判断依据，不能使用整个窗口宽度：小于 680px 为单栏，达到 680px 自动变为左树右预览。
- 宽屏树默认 260px，拖动范围 220–360px，并受容器剩余预览宽度约束；树宽偏好可长期保存。移除当前“预览在左、树在右”和 240–520px 的旧布局常量。
- 窄屏“文件”入口显示完整树；单击项后底部出现 72px 可折叠详情栏（折叠后 28px），显示来源、类型、大小、修改时间、截断路径，以及预览/系统打开/更多。双击或 Enter 后激活具体文件 Tab，显示全页预览；关闭/返回后树的展开与滚动状态不变。
- 宽屏始终保持同一个 `UnifiedFileTree` 实例在左侧；“文件”入口显示当前临时预览，具体文件 Tab 显示对应持久预览。切换文件 Tab 不改变 tree props 的 cache identity，不触发 root/children list 调用，只触发预览读取 effect。
- 从宽屏退回窄屏时保留选择、展开、滚动与文件 Tab；从窄屏升为宽屏时恢复左树，并在右侧显示当前文件或临时选择。
- 文件工作区顶部不再重复当前 56px 大工具栏；路径、文件动作和预览模式收进紧凑预览头，避免 Tab 名称、文件标题、breadcrumbs 三层重复。

**验证**

- 纯布局测试覆盖 679/680px 边界、树宽约束与持久偏好。
- 组件逻辑测试使用列表调用计数器证明：切换两个文件 Tab 后 tree list 调用次数不增加，而 preview read 调用随激活文件变化。
- 运行 `bun test apps/web/src/components/right-panel/right-panel-layout.test.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts`，预期全部通过。

### 6. 抽出单一预览器，复用现有读取接口并新增 HTML 类型

**涉及文件**

- 新建 `apps/web/src/components/right-panel/RightPanelFilePreview.tsx`
- 新建 `apps/web/src/components/right-panel/RightPanelHtmlPreview.tsx`
- 修改 `apps/web/src/components/right-panel/file-preview-utils.ts`
- 修改 `apps/web/src/components/right-panel/file-preview-utils.test.ts`
- 修改 `apps/web/src/components/right-panel/FilesRightPanelTab.tsx` 或在新文件工作区中删除其旧预览分支

**实施内容**

- 将当前 `FilesRightPanelTab.tsx` 中混杂的内容读取、图片处理、Markdown 渲染、菜单与布局拆开；只保留一个按 opaque `FileRef` 读取的预览器，服务端根据 scope 解析真实路径。
- 每次激活具体文件 Tab 都重新读取文件内容；不得以 tree refresh 作为预览更新手段。请求使用递增 request id 或 abort guard，避免快速切换时旧请求覆盖新文件。
- 支持范围固定为：
  - 文本/代码：等宽纯文本，不新增语法高亮依赖；
  - Markdown：默认渲染，支持渲染/源码切换；
  - 图片：自适应并可查看原始尺寸；废弃项目图片的无上限整文件 base64 返回，统一走受控 preview protocol 的流式响应，服务端按 Content-Length 设置明确上限（默认 50MB，超限显示不支持状态）；
  - HTML：渲染/源码切换，渲染模式默认自动执行 JavaScript；
  - 其他二进制、PDF、Office、压缩包、音视频：显示 metadata 与“不支持内嵌预览”，提供系统打开、资源管理器定位、复制路径。
- 延续 512KB 文本截断边界并清楚提示。复制内容与路径必须调用 `writeClipboardText`，禁止使用 `navigator.clipboard.writeText`。
- 预览头保持紧凑：文件图标、basename、必要的最短路径、渲染/源码切换、系统打开和更多。完整 metadata 不与窄屏详情栏重复。
- “系统打开/资源管理器定位”不得调用 sidecar 当前 Windows `cmd /c start` 路径。新增只接受 `FileRef` 的 desktop invoke，main 通过 sidecar 的 authorized resolver 得到真实路径后调用 Electron `shell.openPath` / `shell.showItemInFolder`；renderer 不提交任意绝对路径。
- 空、加载、截断、不支持、读取失败、文件已被移动/删除分别使用稳定状态；文件不存在时当前运行内关闭对应 Tab，不跨重启恢复错误 Tab。
- 使用 `isDesktopRuntime()` 明确分支：非 Electron/Web 托管环境不调用 preview scope invoke；HTML 默认显示源码并提示“交互渲染仅桌面端可用”，本地图片显示稳定的不支持状态，系统打开/定位按钮禁用并说明原因。Markdown/文本等纯内容预览继续工作。补 browser-runtime test，保证不会抛未连接 desktop bridge 错误。

**验证**

- 测试扩展名分类、快速切换竞态、Markdown/HTML 模式、文本截断、图片流式上限、不支持类型、剪贴板入口，以及非 Electron 环境 HTML/source fallback 与图片稳定降级。
- 运行 `bun test apps/web/src/components/right-panel/file-preview-utils.test.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts`，预期全部通过。

### 7. 为 HTML 自动脚本与本地相对资源建立受控桌面协议

**涉及文件**

- 修改 `apps/desktop/src/electron-security.ts`
- 修改 `apps/desktop/src/main.ts`
- 修改 `apps/desktop/src/preload.ts`
- 修改 `apps/web/index.html`
- 修改 `apps/web/scripts/security-policy.test.mjs`
- 修改 `apps/web/src/lib/desktop-api/native.ts`
- 修改 `apps/web/src/lib/desktop-api/index.ts`
- 修改 `apps/web/src/components/right-panel/RightPanelHtmlPreview.tsx`
- 修改 `apps/desktop/scripts/electron-security.test.mjs`
- 新建 `apps/desktop/scripts/html-preview-protocol.e2e.mjs`
- 视现有 sidecar 根解析能力修改 `packages/shared/src/types/agent.ts`、`apps/sidecar/src/rpc/schemas.ts`、`apps/sidecar/src/rpc/agent-handlers.ts`

**实施内容**

- 不使用不受限 `file://`，也不把真实项目根永久加入现有 `lume-file://` 白名单。增加短期、随机、不可猜测的 preview scope token：renderer 只提交 `FileRef`，main 通过 sidecar 的服务端根解析取得 HTML 文件，并把 scope 缩到 **HTML 所在目录及其后代**，不授权整个项目根。token 绑定创建请求的 `webContents.id`、入口 FileRef、canonical preview directory、创建 generation 与到期时间。
- preview URL 使用独立 route，例如 `lume-file://preview/<token>/<relative-path>`。`protocol.handle` 本身拿不到 requester identity，因此 ownership 不能伪写在 handler 中：在默认 session 安装一个集中式、单实例、仅过滤 `lume-file://preview/*` 的 `webRequest.onBeforeRequest` gate，从 request URL 取 token 并核对 `details.webContentsId`；未知/缺失 owner 直接 cancel。该注册器不得覆盖其他 webRequest listener，所有 preview request 通过 gate 后，protocol handler 再验证 URL 解码、NUL/点路径、canonical directory 边界、UNC 与 symlink/junction realpath。
- protocol 响应统一设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。Tab 关闭、来源变化、webContents 销毁或到期时撤销 token；异步创建在组件清理后才返回时立即撤销，不把迟到 scope 留在 registry。
- 本地资源只允许入口 HTML 以及明确的静态 web asset 扩展集合（HTML/CSS/JS/MJS/JSON、常见图片、字体与媒体），拒绝无扩展名、点文件、源码/配置/密钥类型和任何 `../`。因此 `./styles.css`、`./app.js`、子目录图片等工作，但父目录资源与任意项目文件读取明确不支持；远程 CSS、图片、字体、媒体、fetch 与脚本请求允许访问网络。
- HTML directory scope 的授权响应增加 `Access-Control-Allow-Origin: *` 且绝不增加 `Access-Control-Allow-Credentials`，必要时处理只读 GET/HEAD/OPTIONS；这使 opaque-origin iframe 的 module script 和 JSON fetch 可用，但 CORS 只覆盖已通过 token ownership、目录边界和扩展 allowlist 的 route。
- 图片不复用 HTML directory scope。定义 `media-file` 单文件 token，只授权一个 `FileRef`，服务端按文件描述符 `fstat` 确认普通文件、允许的 image MIME 与初始大小，返回明确 Content-Type、`nosniff`、`Accept-Ranges: bytes`，正确处理合法单 Range/206 与非法 Range/416。流式读取中累计实际字节，文件增长超过 50MB 立即中止，不能只信请求前 Content-Length。
- 在 `apps/web/index.html` 的 CSP 中仅把 `lume-file:` 加入 `frame-src`，保留其他 directive；更新 security-policy regression test，防止把危险 scheme 扩散到 script/connect 等不需要位置。
- HTML iframe 使用 `sandbox="allow-scripts"`，不得加入 `allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-downloads` 或 Electron preload。脚本自动执行，但处于 opaque origin，不能访问父页面、Electron API、Cookie 或本地存储。
- 在送入 iframe 前注入最小导航桥：页内 `#anchor` 留在当前页面；同一 preview scope 内的本地链接通过 `postMessage` 请求父页面打开/复用文件 Tab；`http/https` 链接请求系统默认浏览器。父页面把所有 message 当作不可信输入，校验 `event.source`、schema、scope ownership、目标 FileRef，并对远程打开做速率限制和用户确认；不能把 token/nonce 当成“真实点击”的证明。
- 在 Electron `webContents` 层拦截 preview subframe 的 `will-frame-navigate`/等价事件：只允许当前受控 scope URL 和页内 fragment；阻止脚本 `location=...`、meta refresh、top navigation、window.open 等绕过导航桥的行为。其他协议默认拒绝，`mailto` 等只有用户确认后交给系统。
- 记录并接受残余风险：自动执行且可联网的 HTML 可以发送入口文档和允许静态资源目录内的数据、消耗 renderer CPU/内存；opaque-origin sandbox、目录缩小与扩展名 allowlist 降低权限但不能消除拒绝服务与网络泄露风险。

**验证**

- 桌面安全测试覆盖集中 webRequest gate 的 webContents ownership 与 listener 生命周期、token 不可复用/过期、no-store、迟到创建清理、`..` 与编码穿越、绝对路径、UNC、symlink/junction 逃逸、越过 HTML 目录、扩展名拒绝、目录请求、撤销后访问、opaque-origin module/JSON CORS、合法相对 CSS/JS/图片；media-file scope 另测 MIME/nosniff、GET/HEAD、Range 206/416、初始超限、读取中增长超限与只允许单文件。
- Web 侧测试覆盖 CSP 精确 directive、sandbox 属性精确值、远程链接确认与限速、本地链接生成文件 Tab、非法消息/来源被忽略。
- 新增真实 Electron hostile fixture 集成测试：通过实际 protocol 加载 HTML，验证允许的 CSS/JS/图片与网络请求，阻止 location/meta refresh/window.open/top navigation、父目录/点文件读取，关闭 Tab/销毁 webContents 后 token 失效且无缓存命中。
- 运行 `bun test apps/desktop/scripts/electron-security.test.mjs`，预期全部通过。
- 运行 `bun apps/desktop/scripts/html-preview-protocol.e2e.mjs`，预期退出码 0；该命令失败时不得用纯函数测试替代。
- 运行 `bun run --filter @lume/desktop typecheck && bun run --filter @lume/web typecheck`，预期退出码 0。

### 8. 收口文件操作、旧版导出与 Tab 同步，删除右侧面板旧分支

**涉及文件**

- 修改 `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`
- 修改 `apps/web/src/components/right-panel/UnifiedFileTree.tsx`
- 修改 `apps/web/src/components/right-panel/right-panel-files-state.ts`
- 修改 `apps/web/src/components/ui/FileLinkContextMenu.tsx`（仅在能复用现有 action builder 时扩展能力输入；不得破坏其他调用方）
- 修改 `apps/web/src/components/settings/MemorySettings.tsx`
- 修改 `apps/sidecar/src/services/memory-v2/source-open.ts`
- 修改 `apps/sidecar/src/rpc/system-handlers.ts`
- 修改 `apps/web/src/components/right-panel/index.ts`
- 删除右侧面板已无调用的来源切换、旧 breadcrumbs、旧树 resize 与重复 preview helper；不得删除仍被 Agent 侧栏、设置页或主文件预览使用的通用 `FileBrowser`/`WorkspaceFileBrowser`

**实施内容**

- 会话文件操作统一走现有 rename/move/delete RPC。F2 使用紧凑 inline Input；移动使用现有 Dialog/Command/Popover 选择已加载或按需加载的目标目录；删除文件与递归删除目录都使用确认 Dialog，目录文案明确会关闭后代 Tab。
- 重命名/移动成功后，根据 RPC 返回的新路径一次性更新树缓存、选中项、临时预览和全部受影响文件 Tab；删除成功后局部移除节点并关闭对应/后代 Tab。失败时不做乐观提交残留。
- 所有来源复用安全操作：预览、系统打开、资源管理器定位、复制相对/绝对路径；项目、记忆、旧版的写操作不可见或禁用并说明只读原因。
- 全仓枚举并消除三处 Windows `cmd /c start`：`agent-files-service.ts` 的 agent/workspace/project open/show、`memory-v2/source-open.ts` 的 `MEMORY_IPC_CHANNELS.OPEN_SOURCE`（包括 Memory Settings 调用）、`rpc/system-handlers.ts` 的日志/导出/config 打开。renderer 场景迁移到 Electron `shell.openPath/showItemInFolder`；确有 headless 调用的路径改为返回 canonical path 或使用 `spawn` 的安全平台可执行文件且 `shell:false`，不得继续经过 `cmd.exe`。确认 `rg` 无命中后删除旧 helper/channel。
- 旧版导出成功后只把项目来源标为 stale 或局部插入可证明的新节点，不自动切换 Tab、不关闭旧版资源、不覆盖冲突目标。
- 完成替换后删除 `switchFilesSource`、持久化 `selectedPath/searchQuery/treeVisible` 等旧状态以及右侧面板专用的重复大行树渲染分支。优先删除而不是留下兼容壳；只保留仍被已有外部入口调用的窄兼容函数。

**验证**

- 测试文件与目录 rename/move/delete 对 Tab 和树的同步、失败回滚、项目只读、旧版非覆盖导出、剪贴板 IPC、带 `&|<>^%` 等 Windows 元字符文件名的系统打开只经过 Electron shell API。
- 运行本计划列出的 web/sidecar 相关测试集合；不执行与本改动无关的全仓测试。

### 9. 做一次按风险收敛的集成验证与人工桌面检查

**自动验证**

- `bun test apps/web/src/components/right-panel/right-panel-state.test.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts apps/web/src/components/right-panel/RightPanelTabBar.test.ts apps/web/src/components/right-panel/right-panel-layout.test.ts apps/web/src/components/right-panel/file-preview-utils.test.ts apps/web/src/components/right-panel/unified-file-tree-state.test.ts apps/web/src/components/agent/AgentView.test.tsx`
- `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts apps/sidecar/src/rpc/agent-handlers.files.test.ts`
- `bun test apps/desktop/scripts/electron-security.test.mjs`
- `node apps/web/scripts/security-policy.test.mjs`
- `bun apps/desktop/scripts/html-preview-protocol.e2e.mjs`
- `rg -n -F 'spawnDetached("cmd", ["/c", "start"' apps/sidecar/src`，预期无输出且退出码 1。
- 仅因 shared/sidecar/web/desktop 公共接口均发生变化，运行四个相关模块 typecheck；不运行无关 sdk/cli 测试或全仓 lint。

**人工 Electron 验证**

- 在 520px 默认面板确认单栏树、28px 行高、底部详情栏、单击选择、双击/Enter 新建顶层文件 Tab。
- 将面板拖过 679→680px，确认变为左树右预览，树宽 220–360px，状态与滚动不丢失。
- 打开两个同名不同目录文件，确认标题消歧；快速切换 20 次，确认只重读预览、树没有 loading 闪烁或列表请求。
- 测试大量 Tab 横向滚动、全部 Tab 菜单、中键/关闭按钮、关闭“文件”入口后文件 Tab 仍可用。
- 测试会话文件 rename/move/delete 与后代 Tab 同步；确认项目、记忆、旧版无写入口。
- 测试搜索退出后恢复树状态、排除目录提示、显式包含排除目录、旧版 opt-in。
- 测试 HTML 内联脚本、相对 CSS/JS/图片、远程资源、远程链接默认浏览器、本地链接文件 Tab、恶意 top navigation/window.open/path traversal 被阻止。
- 重启应用确认具体文件 Tab 与树导航状态未恢复，但面板宽度和树宽偏好仍在。

## Key decisions & tradeoffs

- **浏览优先，自适应预览。** 窄面板不强塞双栏；宽面板才用左树右预览。代价是窄屏持久预览需要双击或 Enter。
- **统一来源树，不再切换来源。** 项目、会话、记忆与旧版资源同时可见，但权限按来源严格区分。
- **文件 Tab 复用右侧顶层 Tab 栏。** 不再嵌套第二层文件标签；同一路径复用，同名用最短父目录消歧。
- **树缓存与预览读取解耦。** 文件 Tab 切换只重读预览；树仅在用户刷新或本地操作时变化。项目外部变化可能暂时不可见，这是避免新增 watcher 和打断用户的有意取舍。
- **运行态不跨重启。** 减少旧 Tab 和失效路径对用户的打扰，代价是重启后需要重新打开文件。
- **文件 Tab 不是编辑器。** 不加新建、编辑、语法高亮、Git 状态、全文搜索、PDF/Office 查看器或拖放。
- **HTML 自动运行脚本并联网。** 这是用户明确选择；本地访问缩到 HTML 所在目录后代与静态扩展 allowlist，并通过 opaque-origin sandbox、webContents-bound 短期协议、Electron subframe 导航拦截及外链确认限制权限，但仍接受允许目录数据的网络泄露与 renderer 拒绝服务残余风险。
- **不为计数递归项目。** 项目来源不显示总数；会话/记忆/旧版使用低成本已有数据。
- **保留通用旧树调用方。** 只替换右侧面板，不顺手重构 Agent 旧侧栏、设置页或主区域预览，保持 diff 可审查。

## Risks / open questions

- HTML 自动执行且允许联网，恶意或错误脚本可外传其能访问的预览数据、发起网络请求或占满 renderer 主线程；sandbox 不能消除 DoS。
- 为相对资源新增的 preview scope protocol 跨 web/desktop/sidecar 三层，是本计划风险最高的公共接口；必须先完成 CSP、路径安全、ownership/cache 生命周期与 hostile Electron fixture，再接 UI。
- 当前 sidecar 文件搜索为同步、深度受限实现；改成异步扫描后，大型项目仍可能耗时，必须以 debounce、服务端取消、并发/时间预算、`truncated` 和结果上限收口，不能承诺精确总数或瞬时完成。
- 文件列表 metadata 需要额外 stat；网络盘或权限不稳定目录可能返回部分失败。单个条目 stat 失败应降级为无 metadata，不能让整个目录不可见。
- 右侧面板功能状态目前按枚举映射，加入多实例文件 Tab 会改变激活与关闭模型；必须用独立运行态避免污染现有持久化迁移。
- 旧版资源、记忆和项目的路径语义不同，统一树只能统一展示与选择，不能用一个未经来源校验的通用绝对路径 RPC。
- memory settings snapshot 不是完整文件目录；新增分页源文件枚举与 global/workspace 变更事件会扩大 memory 服务契约，但这是统一“记忆源文件”分组正确性的必要成本。
- 本工作树已有与本计划无关的未提交修改；实现必须避开并保留它们，提交前由用户审核完整 diff。

## Out of scope

- 文件内容全文搜索、Git 状态、会话 diff、代码编辑、语法高亮、PDF/Office/压缩包/音视频内嵌预览。
- 新建文件、新建目录、树内拖拽移动、系统拖入、拖到聊天输入框。
- 项目文件写操作；项目目录在右侧文件面板继续只读。
- 新增项目目录实时 watcher、自动整树刷新或跨应用重启恢复文件 Tab。
- 结构化记忆条目、置信度、冲突、归档与编辑；它们继续由记忆设置页负责。
- 旧版资源批量迁移向导。
- 重构仍被 Agent 旧侧栏、设置页、主区域文件预览使用的通用文件树组件。
- 新增第三方依赖或建立完整浏览器隔离进程。
