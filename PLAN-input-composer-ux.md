# Plan: 统一输入框体验与技能/插件引用协议
_Locked via grill — by Codex + user_

## Goal

把欢迎页、会话页和 Quick Input 的输入体验收敛到同一套富文本编辑器、视觉外壳和动作状态机，同时保留各入口真实可用的上下文能力。技能与插件统一从 `/` 面板选择，并以 `lume-skill://...`、`lume-plugin://...` 作为唯一持久化和调用协议；输入、排队、发送、停止、失败恢复、消息展示与复制形成一致、可验证的闭环。

## Approach

1. **先做清理映射和工作树保护，再改共享能力。**
   - 实施前重新执行 `git status --short`，逐个检查本计划会触及的脏文件，尤其是 `packages/sdk/src/agent.ts`、`packages/sdk/src/agent.test.ts`、`apps/sidecar/src/services/agent/prompt/sections/core-sections.ts` 及测试、`apps/web/src/components/agent/RuntimeEventContentBlock.tsx`；只在用户现有改动之上做窄幅合并，不覆盖、回退或顺手整理无关内容。
   - 记录并按依赖顺序迁移当前重复路径：欢迎页独立编辑器、`AgentInput` 编辑器、`LumeComposer` 的 `hero/compact` 变体、`$`/`%` suggestion、插件旧 `$plugin` 路由、角色推荐、重复“图片”附件动作、欢迎页重复模型选择器、输入框内常驻队列列表。
   - 先引入可复用的最小协议/状态能力并迁移调用方，确认没有引用后再删除旧分支；优先删除而不是保留兼容层，不新增依赖，不重排无关文件或做全局格式化。

2. **在 SDK 定义唯一的规范引用契约，并通过 shared 暴露给 Web/sidecar。**
   - 新增无环境依赖的纯函数协议模块，定义三种规范引用：插件 `lume-plugin://<pluginId>`、普通技能 `lume-skill://<skillSlug>`、插件技能 `lume-skill://<pluginId>:<skillSlug>`。标识符必须与注册表中的 canonical id/slug 精确匹配；展示名称永不参与路由。
   - 解析器支持一条消息中的多个引用、去重和规范格式化；同一插件的整体引用覆盖其具体技能引用，避免重复注入。完整 URI 可位于正文任意位置，持久化用户消息保留原 URI。
   - 只把完整且合法的 URI 当作引用。手写 `/foo`、`$foo`、`%foo` 都是普通文本；不完整或畸形的 `lume-*://` 在发送前返回结构化错误，不能静默降级。
   - 明确硬切换：移除 SDK 对 `/skill`、`/skill-name`、`$skill` 的手动技能调用解析，移除 sidecar 对 `$plugin`、`$plugin:skill`、`%plugin` 的显式激活逻辑，不为旧草稿或旧消息做协议回填。历史 `$`/`%`/旧 `/skill` 仅按原始文本显示。
   - 为解析、格式、多个引用、覆盖去重、非法/未知引用和旧语法不再触发编写 SDK 纯函数测试；`@project/...`、`@session/...` 文件协议保持独立，不被本解析器吞掉。

3. **在发送边界统一解析、校验和模型上下文注入。**
   - Web 在提交前用同一协议模块验证编辑器序列化结果；未知、已卸载、禁用、待审核或诊断失败的技能/插件阻止发送，并把错误定位到对应标签。Slash 面板本身只列出当前可调用项。
   - sidecar 把引用校验作为权威边界：根据当前插件注册表和技能目录重新解析；`lume-plugin://id` 激活该插件整体及其可用技能，`lume-skill://pluginId:skillSlug` 只激活指定插件技能，普通 skill URI 只解析对应技能。
   - 持久化及事件投影中的用户正文保留 canonical URI，保证历史渲染、编辑、重发和复制可恢复；送入模型的正文删除 URI，并通过受控 runtime context 注入选中技能/插件的内容与工具约束，不能把 URI 当作自然语言提示词。
   - 调整 `capability-routing.ts`、`core-plugin-hooks.ts`、`agent-prompt-builder.ts` 与 SDK query 入口，使所有主 Agent、重试、排队执行和 headless 调用共用新语义；删除仍指导模型使用 `$plugin` 或旧 `/skill` 的 prompt 文案和测试。
   - 多引用解析必须稳定且幂等：同一引用只注入一次；消息只有引用、删除引用后为空、引用与附件并存等情况都走统一 payload 判定。

4. **补齐插件/技能发现数据，保证稳定 ID、可用状态与图标一致。**
   - 扩展 `AgentPluginListItem` 及 `LIST_PLUGINS` 映射，返回现有 marketplace 配置解析后的 icon asset，不另建图标配置源；复用 plugin market service 的 asset 解析/安全 URL 规则。
   - Slash 面板、编辑器标签和消息标签都以 canonical id 为数据键，以 display name/name 为文案。插件配置 logo 时展示该 logo；未配置或加载失败时用 Lucide `Package`。技能统一用 Lucide `BookOpen`。
   - 列表结果携带足以判断可调用性的 enable/review/diagnostic 状态；禁用、待审核或损坏插件不出现在可选结果中。历史消息仍能用 URI 和缓存/当前元数据展示弱化标签，不把“可展示”误认为“可调用”。

5. **提取一套富文本 Prompt Editor，供三个入口复用。**
   - 保留 TipTap，提取共享的 editor extensions、序列化/反序列化、引用 node、Suggestion 生命周期、粘贴解析、payload 判定、IME 与键盘规则；欢迎页不再维护第二套 Textarea/编辑器行为。
   - `AgentInput` 继续承载线程运行态与 RPC 编排，欢迎页/Quick Input 只提供各自上下文 adapter；避免把全部业务塞入一个巨型组件，也不为了单一调用创建抽象层。
   - 开启标准 undo/redo：`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做；技能/插件/Agent/文件标签插入进入同一 undo 栈。切换线程、恢复草稿或加载待编辑消息时重置 undo 栈，不能撤销到上一线程。
   - `Enter` 发送、`Shift+Enter` 换行；IME composition 期间 `Enter` 不发送。菜单选中后把焦点放回编辑器末尾，发送成功后保持焦点。

6. **把 `/` 收敛为唯一能力面板，同时保持 `@` 的引用职责。**
   - 删除 `$` 技能面板和 `%` 插件面板，`/` 面板按“动作 / 技能 / 插件”分组并跨组搜索；不增加最近使用、收藏或新的独立插件入口。
   - `/` 仅在输入开头或前一个字符为空白时触发，URL、文件路径和普通文本中的 `/` 不触发；选中结果只替换当前 `/查询词`，保留前后正文。未选择的 `/foo` 始终是普通文本。
   - 技能/插件选中后插入富文本引用 node，序列化为 canonical URI，允许继续选择多个引用；动作项直接执行：`/clear` 先确认，`/compact` 和 `/reload-plugins` 使用现有 RPC，`/mcp` 打开其子视图。
   - 动作仅在没有正文、附件或桌面上下文时可执行；有草稿时显示禁用原因。欢迎页隐藏 `/clear`、`/compact` 等线程动作；运行中显示但禁用并解释原因；无 workspace 时技能/MCP 给出空状态，全局可用插件仍可显示。
   - 面板支持方向键、`Enter`、`Tab`、`Esc` 和鼠标；首项高亮、分组标题、禁用原因与结果数量提供可访问语义。复用 shadcn/global 原子组件；如缺少合适浮层原子，先生成全局组件再在业务组件中使用。
   - `@` 继续只负责 Agent 与文件：Agent 始终可选；有 workspace 时支持 `@project/...`；仅已存在会话支持 `@session/...`；欢迎页只提供 Agent + project；无 workspace 时只提供 Agent 并解释文件不可用。

7. **统一引用标签在输入、消息、粘贴与复制中的行为。**
   - 输入框标签展示友好名称与图标，内部 node attrs 保存 canonical URI 和稳定 ID；点击只选中标签，`Backspace/Delete` 删除，不在编辑时跳页。粘贴完整 canonical URI 自动转换为标签，普通文本不猜测。
   - 已发送用户消息中的技能/插件 URI 渲染为紧凑标签；插件使用配置 logo/`Package`，技能使用 `BookOpen`。点击可用标签打开对应详情，悬停显示完整 URI 与状态；缺失/禁用项保留名称或 ID、使用弱化样式，点击提示“当前不可用”。
   - 整条消息复制、选区复制和编辑回填都输出/恢复 canonical URI，而不是可见简称。所有 renderer 剪贴板写入继续使用项目的 `writeClipboardText` IPC 链路，不使用 `navigator.clipboard.writeText`。
   - 合并或替换 `PluginMentionNodeView`、`PluginChipText` 及其 `%` 解析分支，形成技能/插件共用的引用渲染边界；不要改写 `RuntimeEventContentBlock.tsx` 中用户已有的无关工作。

8. **让 `LumeComposer` 成为三个入口相同的几何与视觉外壳。**
   - 删除 `hero/compact` 核心样式差异，三处使用相同圆角、边框、背景、内边距、字体、附件区、编辑区和 footer；只允许外部容器的宽度、定位及 Quick Input 的窄屏降级不同。
   - 编辑区最小高度约 64px、最大高度约 240px，超过后内部滚动；用真实 focus/focus-within 状态驱动强调边框/阴影，不再用 `hasText` 假装聚焦。统一使用 `--lume-*` token，移除欢迎页局部 `--brand` 覆盖。
   - Footer 固定为 `[+] [模型] [权限] [思考] — 弹性空白 — [上下文占用] [主动作]`。欢迎页没有上下文占用；左侧控件空间不足时可换行，主动作固定右侧。欢迎页删除 composer 上方重复模型选择器，保留 workspace selector。
   - 所有可视交互控件复用 `apps/web/src/components/ui` 的 Button、DropdownMenu、Tooltip 等全局原子。业务组件只负责尺寸/布局微调，不手写完整 button/input/menu 视觉体系。

9. **统一附件、建议、草稿、历史和焦点策略。**
   - `+` 菜单只保留“文件”和“当前应用”；文件选择统一接受文件/图片，删除重复“图片”和插件入口。拖放与文件选择进入同一 pending attachment 管线。
   - 新增共享的紧凑 pending attachment 展示：文件显示图标、名称、移除；图片显示约 40px 缩略图、名称、移除；自动换行并设最大高度/内部滚动。已发送消息的 `AgentAttachmentGrid` 保持现状。
   - 欢迎页建议仅在正文、引用、附件、桌面上下文都为空时出现；点击只填入并聚焦，不自动发送。删除输入框的自动角色推荐 chips，Agent 统一通过 `@` 选择；消息头像、已有 Agent 标签和重写能力不受影响。
   - 三个入口都有草稿：欢迎页使用独立 new-session draft，线程页/Quick Input 按 threadId 共用草稿；所有程序化插入同步保存。历史回溯只用于已存在会话，恢复历史不污染其他线程。
   - 欢迎页和 Quick Input 展示后自动聚焦；从新建、搜索或线程列表进入会话时，在无 modal/设置/文件交互时聚焦。菜单关闭、发送完成返回焦点；用户正在消息、文件、设置或 modal 中操作时不抢焦点。

10. **用一个自适应主按钮和事务式提交流程统一发送、排队与停止。**
    - 主按钮保持稳定最小宽度并显示文字 + 图标：空闲且有 payload 为“发送”；流式且无 payload 为“停止”；流式且有 payload 为“排队”；本地提交阶段为“发送中”且禁用。Quick Input 极窄时允许图标模式，但必须有 tooltip 和 accessible name。
    - 提交前依次完成引用校验、桌面上下文刷新、附件保存和 dispatch；这一短阶段锁定编辑器、引用、附件删除、模型/权限/思考配置并防止双击提交，不提供第二缓冲区。
    - 只有 sidecar 明确返回 `sent` 或 `queued` 后，才清空正文/附件/上下文、写入输入历史并清除对应草稿。失败时完整保留 payload 与配置，解锁并重新聚焦，同时显示就近错误与 toast。
    - 欢迎页只有 dispatch 成功后才导航到新线程并清空 welcome draft；失败时留在欢迎页，回滚本次创建且没有有效消息的空线程和临时附件，避免孤儿线程。停止失败只反馈错误，不伪造 idle。
    - `Esc` 使用 800ms 双击窗口：第一次按优先关闭 `/`、`@`、`+` 等本地面板，退出历史回溯或取消消息编辑，不清草稿；若当前线程仍在输出，显示“再次按 Esc 停止输出”的轻提示。窗口内第二次按调用 `STOP_THREAD`；空闲双击无破坏性动作。Quick Input 不再用单次 Esc 隐藏，仍通过 `Alt+L` 或窗口控件关闭。

11. **把队列从“正文列表”升级为完整快照与可恢复编辑事务。**
    - 为 queued dispatch 定义可序列化的公开 payload 快照：富文本正文/canonical URI、附件、桌面上下文元数据、模型、权限模式、思考等级及执行所需 workspace/thread binding；不暴露 provider secret 或无关内部对象。
    - 入队后工具栏修改只影响当前草稿。编辑队列项时复用同一富文本编辑器，显式进入 queue-edit 模式；原项在保存成功前继续留在队列中，保存通过 update RPC 原子替换，取消则完全不变。消息版本历史继续只读，不增加 composer toolbar。
    - 输入框顶部默认只显示“n 条排队消息”的紧凑摘要；展开后在 composer 上方显示完整列表，支持拖拽排序、编辑、删除、设为下次工具调用前引导。队列 UI 不占用 editor 滚动区，不改变当前草稿和焦点；空队列及欢迎页不显示。
    - 每条真正执行前在 sidecar 重新校验引用、附件和 workspace binding。队首失效时标记为“需要处理”并暂停严格 FIFO；不自动运行后续项。用户可编辑后重试、删除，或明确“跳过并继续”，随后恢复队列。
    - 复用现有 runtime kernel 的队列顺序与运行周期，不实现跨 sidecar/app 重启恢复；完整快照只在当前运行周期存在。更新 list/reorder/remove/promote API 与队列状态测试，避免现有 `startEditingQueuedMessage` 先删除原项造成数据丢失。

12. **按风险分层做定向验证并完成删除收口。**
    - SDK：运行 canonical 引用解析、旧协议硬切换、多 skill/plugin 注入、原消息持久化与模型正文剥离相关测试，包含用户当前新增的 filesystem skill 热刷新测试，确保合并后仍成立。
    - sidecar/shared：运行插件列表 icon/status 映射、capability routing、plugin hooks、prompt builder、发送校验、队列完整快照/FIFO 暂停/原子编辑/跳过恢复、RPC schema 的定向测试；公共接口变化后执行相关 package typecheck。
    - Web：运行 slash/suggestion、编辑器引用序列化与粘贴、submit state、草稿/历史、队列 state、Quick Input Esc、Welcome 事务发送、消息引用渲染与复制等涉及逻辑的定向测试。纯样式只做三个入口的人工视觉检查，不为视觉仪式性新增测试。
    - 人工验收覆盖欢迎页、已有会话、Quick Input 的空闲/流式/有草稿/失败/窄宽度/无 workspace/禁用插件场景，以及键盘、IME、undo/redo、800ms 双 Esc、附件溢出和队列暂停。
    - 最后用 `rg` 确认生产代码/prompt 不再注册 `$`、`%`、旧 `/skill` 触发器或 `hero/compact` 分支，删除迁移产生的 orphan imports/components，再执行 `git diff --check`；不运行与改动无关的全量测试。

## Key decisions & tradeoffs

- 三个入口共享同一套编辑器能力和视觉几何，但通过 context adapter 暴露真实能力；欢迎页不会伪造会话上下文、历史、队列或 `/compact`。
- `/` 是技能、插件和动作的唯一发现入口，`@` 专注 Agent/文件；规范 URI 才是持久化和运行协议。硬切换能删除多套解析分支，代价是旧 `$`、`%`、`/skill` 文本不再调用能力。
- 用户消息保留 URI，模型输入剥离 URI 并注入受控上下文；这样历史可复制/编辑且模型不会把内部路由字符串当指令，代价是发送边界必须同时测试展示正文与模型正文。
- 插件整体引用覆盖同插件的具体技能引用，支持多引用但不重复注入；无效引用 fail closed，不能悄悄以普通文本执行。
- 一个主按钮根据运行态和 payload 在发送、停止、排队间变化；有待发送内容时鼠标主动作优先排队，停止仍可通过清空 payload 后的按钮或双 Esc 完成。
- 提交采用短锁 + 成功后清空，避免失败丢稿和重复发送；代价是附件保存/上下文刷新期间暂时不能调整配置。
- 队列严格 FIFO，失效队首暂停而非自动跳过；这保护上下文顺序，但需要用户明确处理后才能继续。
- 队列保存当前运行周期内的完整快照，不做跨重启持久化；避免本次引入恢复 schema、过期附件清理和启动时重放语义。
- pending attachment 使用独立紧凑视图，已发送附件保持原样；避免为输入态优化意外改变历史消息布局。
- 使用现有 TipTap、Lucide、marketplace asset、shadcn/global 原子和 IPC，不增加依赖。

## Risks / open questions

- 当前工作树已有与 SDK skill 热刷新、prompt、消息 renderer 等重叠的用户改动；实施必须先重新核对 diff，并把协议改造叠加在这些行为之上。没有剩余产品决策，但存在合并冲突风险。
- 欢迎页当前没有 threadId，而 project 文件搜索接口可能依赖 threadId；实现需要复用 FileRef 授权增加窄的 threadless project search，或让现有搜索按 workspace binding 工作，不能为搜索预建并遗留线程。
- 插件 logo 可能缺失、损坏或 URL 不可加载；所有位置必须一致回退 `Package`，并继续使用现有 marketplace asset 安全边界。
- TipTap 自定义 node、纯文本 URI、历史 draft JSON 与消息 Markdown 之间存在多个序列化入口；若只迁移发送路径，会导致编辑/复制/重发丢失 canonical ID，因此验收必须逐入口覆盖。
- 当前队列公开类型只有 `text`，编辑动作会先移除原项；扩展完整快照和 update/pause API 会触及 shared/sidecar/web 公共契约，是本任务最高风险的接口变化。
- hard cutover 后历史消息中的 `%plugin` 可能从旧插件 chip 退回普通文本，这是明确接受的兼容性损失；canonical URI 历史消息仍需稳定展示不可用状态。
- 欢迎页线程创建和附件保存目前跨多个 IPC；失败回滚必须只删除本次创建且仍为空的资源，不能误删并发写入或已存在线程。
- 真实 focus 管理、Suggestion portal 与双 Esc 监听都涉及 document/window 生命周期；需要验证 Quick Input 与主窗口不会重复注册或互相停止错误线程。

## Out of scope

- 旧 `$skill`、`%plugin`、`$plugin:skill`、`/skill` 文本的兼容解析、历史批量迁移或草稿自动改写。
- 消息队列跨 app/sidecar 重启持久化、启动恢复、过期队列自动清理或后台同步。
- 新增最近使用、收藏、固定分组、拖拽自定义 `/` 面板排序或插件快捷入口。
- 改造已发送附件卡片、消息版本历史、Agent 头像/重写交互或右侧文件预览体验。
- 移动端专用布局；仅保证桌面主窗口和 Quick Input 的窄宽度可用性。
- 新插件 logo 上传/编辑功能、远程图片代理、品牌图标库或新的 UI/编辑器依赖。
- 改变 `@project/...`、`@session/...` 文件引用协议本身；本计划只把它们接入统一编辑器和入口可用性规则。
- 全量设计系统重构、全仓 lint/typecheck/test、无关死代码清理或提交/发布操作。
