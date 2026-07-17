# Plan: 为 Lume 构建独立、可维护的 LLM Wiki
_Locked via grill — by Codex + user_

## Goal

在 Lume 功能页内新增与「一起读书」「今日日程」平级的 Wiki，帮助用户把明确选择的聊天、网页、文件、读书笔记、Memory 条目和手工内容沉淀为一套本地优先、可追溯、可持续维护的知识库。Wiki 是独立于工作区和 Memory V2 的统一区域：每个页面只有一个主要工作区归宿，但可关联多个工作区；原始来源保持不可变，Wiki 页面可以在引用、审核、版本历史和撤销保护下持续演化。数据使用开放 Markdown，Lume 自身提供完整浏览、搜索、编辑和维护能力，同时兼容作为 Obsidian Vault 打开，不依赖 Obsidian 才能工作。

## Approach

1. **建立独立 Wiki 领域模型和共享协议。**
   - 在 `packages/shared/src/types/wiki.ts` 定义并从共享入口导出版本化类型；不要把 Wiki 页面伪装成 Memory V2 entry，也不要复用 Memory 的 `preference/fact/state` 语义。
   - 首版页面类型固定为 `source | topic | decision | synthesis`：
     - `source` 是单一原始来源的摘要和引用入口；
     - `topic` 统一承载概念、人物、产品和事件等长期主题；
     - `decision` 记录决定、理由、替代方案和后续状态；
     - `synthesis` 记录跨来源比较、路线图和综合分析。
   - 每个页面 frontmatter 至少包含 `schema_version/id/type/title/primary_workspace/associated_workspaces/status/aliases/tags/source_ids/created/updated/revision`。`id` 是内部稳定身份，文件名可读但不承担身份；`primary_workspace` 只能有一个，跨工作区关系使用 `associated_workspaces` 和 Wiki 链接。
   - 定义独立的 `WikiPageRef`、`WikiSourceRef`、搜索范围、变更草案、批次、diff、待审核、历史版本、lint finding、访问授权和 RPC 输入输出类型。聊天中的 Wiki 引用打开 Lume Wiki 页面，不强行扩展线程右侧文件树的 `FileSource`。
   - 页面状态为 `active | archived | trashed`；来源状态区分 `snapshotted | extracted_only | external_only | trashed`。永久删除不是普通状态更新，必须经过影响分析。

2. **使用一个中央、Obsidian 兼容的 Markdown 目录，并把内部状态隔离。**
   - 在 `apps/sidecar/src/services/infra/config-paths.ts` 增加固定 Wiki 根目录，默认结构：
     ```text
     <config>/wiki/
       inbox/
       workspaces/<workspace-slug>/{sources,topics,decisions,synthesis}/
       archived-workspaces/<workspace-slug>/...
       sources/<content-hash>/index.md
       assets/<content-hash>/...
       .lume/{index,operations,snapshots,pending,staging,trash}/
     ```
   - 用户内容全部是普通 UTF-8 Markdown、YAML frontmatter、`[[Wiki links]]` 和相对附件；`.lume/` 只保存可重建索引、操作日志、审核队列和恢复数据。不得要求 `.obsidian/`、Dataview 或社区插件存在。
   - 增加 `WikiMarkdownStore`、`WikiSourceStore` 和严格路径解析器。所有 sidecar 写入使用现有原子写模式和安全 segment 校验；禁止页面标题、workspace slug、source URL 或外部 ID 直接参与未经校验的路径拼接。
   - 内容来源按 SHA-256 去重。来源 payload 和首次生成的 manifest 一经提交不再覆盖；反向引用、使用次数和搜索状态放在可重建索引中，不回写不可变 payload。
   - 网页保存抓取时的 Markdown、元数据和必要本地图片；聊天保存所选消息正文快照及 thread/message/run ID；本地文件保存摄入时副本。单个原件默认上限 25 MiB，超过上限或无法复制时保存哈希、原路径、抽取文本和 `external_only/extracted_only` 警告，不谎称已经完整归档。
   - Wiki 根目录可直接作为 Obsidian Vault 打开。桌面端通过官方 `obsidian://open?path=...` 形式提供可选「在 Obsidian 中打开」，失败时只提示安装/注册 URI；Lume 的读写、链接和搜索不得依赖 Obsidian 进程。

3. **定义可演化页面格式和内容所有权，保护用户编辑。**
   - 页面正文采用稳定章节：摘要、已知内容、用户批注、开放问题、相关页面。来源引用必须落到 `WikiSourceRef` 或原始聊天/文件定位；LLM 输出只能标记为综合内容，不能伪装成原始事实。
   - Agent 维护段落使用 Obsidian 可忽略的 HTML 注释记录 `block_id/owner/revision/source_ids/content_hash`；`用户批注` 默认 `owner=user`，任何自动流程都不得覆盖。
   - Lume 内直接编辑时记录实际变动的 block；外部编辑器修改后，由 watcher 对比最后提交快照：被用户改变的 Agent block 自动升级为 `owner=user`。如果标记被删除、页面解析失败或所有权无法判定，整页进入受保护状态，后续 Agent 改写必须审核，不能猜测恢复标记。
   - 页面重命名以稳定 ID 为核心，并在一个批次内重写已知入链的 `[[path|title]]`。旧标题进入 `aliases`；外部重命名通过 watcher 识别 ID 后更新索引。发现重复 ID、无法解析的链接或同名歧义时生成 finding，不静默选择目标。
   - 用户可编辑整篇 Markdown和元数据表单，也可要求 Lume 拆分、合并、补充或重写；删除、合并、覆盖用户拥有内容始终属于高风险草案。

4. **用带前置条件的操作批次保证多文件更新、撤销和外部编辑并存。**
   - 在 `apps/sidecar/src/services/wiki/` 增加单一 `WikiMutationCoordinator`，所有 UI 保存、导入确认、Agent 变更和 lint 修复都经过它；不要让各 RPC handler 或工具直接写 Markdown。
   - 草案必须列出每个目标的 `beforeHash`、创建/修改/移动/删除操作、来源、风险原因和预览 diff。确认时重新校验 hash；任何页面被用户或 Obsidian 改过都拒绝原草案并要求重新生成，防止丢失更新。
   - 多文件提交使用 `prepared -> applying -> committed` journal、同文件系统 staging、逐文件原子替换和 before/after snapshots。因为文件系统不提供真正多文件事务，启动恢复必须根据 journal 完成或回滚未完成批次，不能留下半更新索引或半重写链接。
   - 正常的新建、Agent 管理区增量更新、索引和机械链接修复在用户确认收录后作为一个批次直接应用；删除页面、覆盖用户内容、冲突合并、低置信度归并和永久删除进入 `.lume/pending/`。
   - 撤销只有在当前文件 hash 仍等于该批次 `afterHash` 时直接执行；否则生成逆向草案进入审核，避免撤销覆盖后续编辑。新来源在撤销后若无人引用先进入 trash，不立即物理删除。
   - 操作日志追加记录批次发起者、来源、风险、时间、受影响 ID 和结果，但不复制完整敏感正文；完整恢复内容只存在本地 snapshots，并纳入数据清理/永久删除规则。

5. **实现显式导入和“沉淀到 Wiki”草案流程，不做后台自动摄入。**
   - 新增 source adapters：粘贴文本、URL/已有 WebFetch 资产、本地文件或文件夹、工作区文件、选中的聊天消息、读书笔记和显式选择的 Memory V2 entry。复用现有网页抓取、reading store、Memory source open 和线程持久化读取能力，不另造第二套抓取器或会话存储。
   - Wiki 顶部提供一个明确的「导入」动作；聊天消息/助手结果、读书笔记、Memory 条目和文件菜单提供「沉淀到 Wiki」。不在升级、启动、每轮聊天结束或读书笔记生成后自动扫描和建页。
   - 导入先写有过期时间的 `.lume/staging/<draftId>`，生成轻量确认单：建议标题、页面类型、主要归属、关联工作区、来源和将新建/更新的页面。取消或过期只清 staging，不改变正式来源库和 Wiki。
   - 用户可修改标题与归属后一次确认批次。Agent 回答被收录时创建/更新 `synthesis`，并保留它引用的原始证据；没有原始证据的段落明确标为模型综合。
   - 内容 hash 先完成来源去重；页面候选再按稳定 ID、alias、标题、显式链接和相似度提出“更新现有/新建”建议。相似度只能提出候选，不能直接合并；歧义和冲突进入审核。
   - 现有 Memory、聊天、读书和资源数据不迁移、不改格式。首版唯一历史入口就是显式「导入」或各处「沉淀到 Wiki」。

6. **建立独立、可重建的全文/链接/语义索引。**
   - 使用运行时已有的 `node:sqlite` 和 FTS5 建立 Wiki 索引，不新增依赖。表至少覆盖 pages、page sections、sources、tags、workspace associations、links、aliases、source citations、revisions 和 lint findings；索引位于 `.lume/index/`，不是事实来源。
   - 正式批次先提交 Markdown/journal，再增量更新索引并写 generation。索引失败不能回滚已经安全提交的知识文件；应标记 stale，并在下次启动/搜索时根据 Markdown 和 source manifests 完整重建。
   - 复用 Memory V2 已有的 embedding provider、local ONNX、rerank 和向量数学能力，但建立 Wiki 专属增量 embedding cache，key 为 `modelKey + blockContentHash`。不要复用 Memory 当前“任一文件变化就重建全部 JSON embeddings”的索引实现。
   - `wiki.search` 先执行作用域/权限过滤，再组合 FTS、标题/alias、链接邻域和可选语义结果，使用确定性融合后只对 top candidates rerank。默认检索当前工作区主要归属和关联页面；“全部 Wiki”必须由用户或 Ask Wiki scope 明确给出。
   - `wiki.read` 返回页面、受限来源摘要和引用；事实性回答继续读取对应不可变来源，不能只引用 Wiki 二手综合。`wiki.follow_links` 只遍历已经授权的页面，防止从一个允许页面跨到未授权文件夹。
   - 首版验收数据集按 5,000 个页面、50,000 个可搜索段落验证；warm lexical search 目标低于 300 ms，未调用远程 rerank 的本地 hybrid search 目标低于 2 s。模型下载和远程供应商延迟单独展示，不混入本地索引指标。

7. **接入 Agent runtime，但把正式写入权留在用户确认边界。**
   - 在 `apps/sidecar/src/services/agent-runtime/tools/wiki/` 增加 `wiki.search`、`wiki.read`、`wiki.follow_links` 和 `wiki.propose_changes`，接入 `create-lume-tools.ts`、sidecar/web tool metadata 与权限设置。
   - 前三个是只读工具；`wiki.propose_changes` 只能创建 staging draft 并返回确认卡所需数据。不得向模型暴露绕过确认的 `wiki.apply` 或任意 Wiki 文件写工具。正式 apply/resolve/undo 只允许经过校验的 renderer RPC 和明确用户动作。
   - 普通对话不预加载整座 Wiki。Agent 根据问题按需检索；“向 Wiki 提问”从 Wiki 页面打开普通 Lume 会话，并写入受校验的 scope attachment（当前页面、文件夹、工作区或全部 Wiki），复用现有 Agent runtime、消息历史和工具调用 UI。
   - 桌面直接会话默认只读当前工作区范围；全部 Wiki 和跨工作区需要显式 scope。IM 私聊默认无 Wiki 授权，群聊/频道默认禁用；授权只能绑定特定工作区文件夹，不能给外部渠道开放全库。过滤必须发生在搜索、读取、rerank 和 prompt assembly 之前。
   - 外部渠道即便获得读取授权，也只能生成待桌面审核的写入草案；外部参与者不能使正式 Wiki 静默变化。所有事实回答返回 Wiki 页面引用并尽可能附原始来源引用。
   - Memory 与 Wiki 存储、索引、工具和 UI 保持隔离。Agent 可在同一回答中分别查询两者，但必须标明来源；Memory 到 Wiki、Wiki 到 Memory 都只有显式用户动作，没有双向自动复制。

8. **把 Wiki 放进 Lume 功能页，并提供原生浏览、编辑、审核体验。**
   - 将当前写在 `ReadingView.tsx` 内的「一起读书 / 今日日程」导航提升到 `components/lume/LumeView.tsx`，形成 `reading | routine | wiki` 三个平级功能；保持首次默认「一起读书」，并记住用户最近选择。`ReadingView` 只负责读书，`RoutinePanel` 只负责日程，避免让 Wiki 继续耦合进 Reading 状态。
   - 在 `apps/web/src/components/wiki/` 建立 `WikiView`：左侧为收件箱、工作区文件夹、已归档工作区、标签和待审核；中间为页面列表、搜索和筛选；主区为 Markdown 阅读/编辑与元数据表单。
   - Wiki 内提供可折叠 inspector，展示来源、反向链接、版本历史、diff 和 lint findings。复用现有 Markdown renderer、文件/图片预览、ScrollArea、Dialog、Select、Input、Textarea、Button 等全局原子组件；不重构只支持 agent thread 的全局 `RightPanelWorkspace`。
   - 阅读模式渲染 Wiki links、引用状态、所有权和 stale/conflict 警告；编辑模式直接编辑 Markdown，frontmatter 通过表单管理。首版不做 Notion 式块编辑器、所见即所得编辑器或原生节点图。
   - 收录确认卡显示建议标题、页面类型、主要归属、关联工作区、来源、风险和受影响页面；确认后展示批次摘要、diff、打开页面和撤销入口。高风险项进入待审核视图，支持 accept/edit/reject，不以 toast 代替可恢复状态。
   - 搜索只找页面/来源；「向 Wiki 提问」打开普通聊天。Wiki 引用从聊天点击后切回 Lume 的 Wiki 子页并定位 page ID，不能依赖当前文件名仍然相同。

9. **持续执行写后结构 lint 和周期性语义健康检查。**
   - 每个提交批次后运行确定性检查：frontmatter/schema、重复 ID、断链/歧义链接、缺失来源、孤立页面、无效 workspace association、source hash 和 operation journal 完整性。机械且不改变语义的修复可并入当前批次，其余生成 finding。
   - 增加手动「检查 Wiki」和默认每周一次的本地健康任务；复用现有 routine/后台 job 状态与模型策略，不另建第二套调度器。没有可用模型时只运行结构检查，并明确显示语义检查未执行。
   - 语义 lint 检查疑似冲突、陈旧结论、近似重复、缺失主题页和知识空白，只写待审核 findings，不自动搜索外网、不自动重写页面。它可建议应该调查的问题和来源，但由用户决定是否搜索/导入。
   - 任务记录 last successful generation、模型、范围、耗时和 finding counts，失败可重试且不会阻塞读取；同一 generation 不重复运行。用户可以关闭周期性语义检查或手动触发，但结构检查不可关闭。

10. **处理工作区生命周期、删除、导出和彻底清除。**
    - Wiki 位于中央根目录，删除 Lume 工作区不得被 `deleteAgentWorkspaceInternalData` 级联删除。工作区删除成功后触发 Wiki lifecycle handler，把对应物理目录原子移动到 `archived-workspaces/<slug>/` 并把页面状态改为 archived；失败要报告并允许恢复，不能先删知识再尝试归档。
    - 归档页面仍可在全部 Wiki 搜索中找到，可重新指定主要归宿。被其他页面关联的来源或页面删除时先计算影响；普通删除进入 Wiki trash，永久删除需要二次确认和批次审核。
    - 删除原聊天、读书笔记、工作区资源或本地原文件不级联删除已经明确沉淀的 Wiki 快照。相应删除 UI 在可判定时提示“内容已独立归档到 Wiki”。
    - 增加 Wiki 专属隐私清除：按 page/source/thread/message/workspace 追踪引用，展示受影响页面，删除来源 payload、派生 blocks、索引、staging、snapshots 和 operation 正文恢复数据，并留下不含正文的 tombstone，防止重建时复活。
    - 扩展数据管理统计、全量导出和清理边界：Wiki Markdown 与来源默认随用户数据导出；SQLite/embedding index 是可重建缓存；普通缓存清理不能删除 Wiki、来源、版本或待审核项。

11. **用针对性测试证明边界，而不是新增一套泛化框架。**
    - Shared/sidecar 单元测试覆盖 schema、路径逃逸、frontmatter round-trip、稳定 ID、alias/rename、content hash 去重、所有权升级、风险分类、权限范围、link resolution、搜索融合和 lint rules。
    - Store/coordinator 集成测试覆盖：正常多页 ingest、确认前零正式写入、stale `beforeHash` 拒绝、外部编辑竞争、journal 中断恢复、索引失败后重建、撤销前置条件、来源删除影响分析和工作区归档不丢知识。
    - Agent tool 测试证明 read tools 先做 scope filter、`wiki.propose_changes` 不写正式库、没有模型可调用 apply、IM/group 默认无访问、引用会下钻到来源。
    - Web 状态/交互测试覆盖 Lume 三个功能切换、导入确认、Markdown 保存冲突、待审核、inspector、Ask Wiki scope 和 Wiki 引用定位。只对可测试逻辑运行相关测试；不因纯样式调整执行全量 test/lint/typecheck。
    - 增加一个小型端到端 fixture：导入两份相互矛盾的来源，创建 topic + synthesis，用户修改一段，第二次 ingest 只能自动更新 Agent 区并把冲突/用户覆盖送审；删除工作区后页面仍在 archived-workspaces，可搜索、可撤销、可用 Obsidian 打开。

12. **以最小迁移和可回滚方式发布。**
    - 首次进入 Wiki 才创建目录和索引；已有用户看到空 Wiki 和「导入」动作，不执行 Memory/聊天/读书后台迁移。
    - 不新增依赖；优先复用 `node:sqlite`、现有 Markdown/预览组件、WebFetch、Memory embedding/rerank adapters、routine jobs、原子写和 watcher 模式。
    - 实施时保留当前工作树中 `ReadingView`、侧栏和 reading service 的用户改动，先检查重叠 diff，再做局部修改；不要顺手整理无关 UI 或 Memory V2。
    - 每个实施提交遵循仓库 Lore 协议，按 shared/sidecar/web/desktop 边界保持可审阅；功能未完整接通前不把未使用的 Wiki tool 暴露给模型。

## Key decisions & tradeoffs

- **独立统一 Wiki，而非每个工作区一座库。** 工作区是主要归宿和权限范围；一个页面只有一个物理归宿，可关联多个工作区，避免复制后漂移。
- **Wiki 与 Memory V2 分离。** 两者复用底层检索能力，但语义、存储、索引和权限独立，只允许用户显式提升，不做自动双向同步。
- **显式沉淀优先。** 用户发起导入/沉淀，Agent 只建议；没有普通聊天、读书或启动时的静默自动摄入。
- **来源不可变，Wiki 可演化。** 来源事实、模型综合和用户批注明确分层；事实回答应下钻原始来源。
- **正常批次自动应用，高风险送审。** 用户确认收录后不逐文件确认，但覆盖用户内容、删除、冲突和低置信度合并必须审核；所有提交可查看 diff，并在前置条件成立时撤销。
- **Lume 原生，Obsidian 可选。** Markdown/Wiki links/frontmatter 保持 Vault 兼容，但不依赖 Obsidian、插件、Sync 或 Publish。
- **Markdown 编辑而非块编辑器。** 首版提供渲染阅读、Markdown 编辑、元数据表单和自然语言修改；用 block ownership 保护用户编辑。
- **问答复用普通 Agent 会话。** Wiki 页面负责浏览、搜索、编辑和审核；Ask Wiki 只给正常聊天附加受限 scope，不重复建设聊天 runtime。
- **本地单用户首版。** 不处理云同步、多人实时编辑、组织 ACL 或合并冲突服务；仍需处理 Obsidian 等外部本地编辑造成的并发。
- **不做原生图谱。** 首版以双向链接、反向链接、相关页面和 lint 提供结构；需要节点图时可用 Obsidian。
- **不复用线程右侧面板。** 当前面板只支持 agent thread；Wiki 使用功能页内 inspector，避免把本任务扩大为全局面板架构重写。
- **不自动迁移。** 只增加显式「导入」和「沉淀到 Wiki」，现有 Memory/聊天/读书/资源格式保持不变。

## Risks / open questions

- **外部 Markdown 编辑可能破坏标记或链接。** 通过稳定 ID、hash 前置条件、watcher、alias 和“无法判定即保护整页”处理；不尝试无证据的自动修复。
- **文件系统没有多文件事务。** journal + staging + before/after snapshots 提供可恢复原子批次语义；索引作为派生层可重建。
- **来源快照可能快速占用磁盘。** content hash 去重、25 MiB 原件上限、数据管理统计和显式清理控制；不以删除索引冒充清理来源。
- **LLM 综合可能传播错误。** 模型内容标为 synthesis，重要 claim 保留 source IDs，冲突/低置信度送审，事实查询下钻来源，语义 lint 不自动改写。
- **周期性语义检查有模型成本。** 复用配置模型，记录每次执行，无模型时降级结构检查，并允许用户关闭语义周期任务。
- **搜索规模超过首版目标后需要更强 ANN。** 首版以 FTS5、增量 section embeddings 和受限 rerank 服务本地规模；超过验收规模后再以数据决定是否引入 ANN，不提前加依赖。
- **现有 `ReadingView` 和侧栏有未提交改动。** 实施前必须检查重叠 diff并保留用户改动；本计划不授权清理或覆盖这些变化。
- **没有未决产品问题。** 页面数阈值、25 MiB 快照上限和每周语义检查是首版运维默认值，可在实现验证中下调以满足稳定性，但不得改变显式沉淀、权限、来源和审核边界。

## Out of scope

- Obsidian 作为必需运行时、捆绑分发、社区插件开发、Obsidian Sync/Publish 集成。
- 多人实时协作、云同步、组织级 RBAC、服务端 Wiki、共享 Vault 冲突合并。
- Notion 式 block editor、完整 WYSIWYG、Canvas、原生交互式知识图谱。
- 自动抓取全部聊天、全部 Memory、全部读书笔记或全部工作区文件；升级时自动迁移历史数据。
- Agent 无确认直接写正式 Wiki、自动外网补全知识、语义 lint 自动修改结论。
- 用 Wiki 替换 Memory V2、工作区 resources、线程附件、读书 store 或原始会话记录。
- 首版支持任意二进制格式的深度解析、OCR、音视频转录或无限大小原件归档；继续使用已有工具能处理的格式。
