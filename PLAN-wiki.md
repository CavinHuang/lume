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
   - 每个页面 frontmatter 至少包含 `schema_version/id/file_key/type/title/primary_workspace_id/primary_workspace_snapshot/associated_workspace_ids/status/aliases/tags/source_ids/created/updated/revision`。`id` 是内部稳定身份；`file_key` 是全库唯一、创建后不变的 Obsidian basename。`primary_workspace_id` 为不可复用的 workspace UUID 或 `null`，`null` 明确表示 inbox；slug/name 只作为展示快照，绝不用于 ACL 或身份判断。跨工作区关系使用 `associated_workspace_ids` 和 Wiki links。
   - 定义独立的 `WikiPageRef`、`WikiSourceRef`、搜索范围、变更草案、批次、diff、待审核、历史版本、lint finding、访问授权和 RPC 输入输出类型。聊天中的 Wiki 引用打开 Lume Wiki 页面，不强行扩展线程右侧文件树的 `FileSource`。
   - 页面状态为 `active | archived | trashed`。来源拆成不可变 `capture_mode: snapshotted | extracted_only | external_only` 与可变 `lifecycle_state: active | trashed | purged`；永久删除不是普通状态更新，必须经过影响分析。

2. **使用一个中央、Obsidian 兼容的 Markdown 目录，并把内部状态隔离。**
   - 在 `apps/sidecar/src/services/infra/config-paths.ts` 增加固定 Wiki 根目录，默认结构：
     ```text
     <config>/wiki/
       inbox/
       workspaces/<workspace-id>--<slug-snapshot>/{sources,topics,decisions,synthesis}/
       archived-workspaces/<workspace-id>--<slug-snapshot>/...
       assets/<content-hash>/...
       .lume/{index,operations,snapshots,pending,staging,trash}/
       .lume/sources/blobs/<content-hash>/payload
       .lume/sources/records/<source-record-id>.md
     ```
   - 用户内容全部是普通 UTF-8 Markdown、YAML frontmatter、`[[Wiki links]]` 和相对附件；`.lume/` 只保存可重建索引、操作日志、审核队列和恢复数据。不得要求 `.obsidian/`、Dataview 或社区插件存在。
   - 增加 `WikiMarkdownStore`、`WikiSourceStore` 和严格路径解析器。所有 sidecar 写入使用现有原子写模式和安全 segment 校验；禁止页面标题、workspace slug、source URL 或外部 ID 直接参与未经校验的路径拼接。Vault 可被 Obsidian 或用户修改，因此 store 的扫描、watch、读取、hash、replace、move 和 delete 都必须逐层 `lstat`，拒绝 symlink、junction 和其他 reparse point，并验证每个已存在父目录的 canonical realpath 始终位于 canonical Wiki root；读写不能仅在最终路径做字符串前缀判断。
   - 只对来源 payload blob 按 SHA-256 去重。每次摄入仍创建独立 provenance record，记录来源类型、不可变 `capture_mode`、`capture_scope_snapshot`、thread/message/file/URL 定位和 blob hash；同一正文来自私聊与公开网页时不得合并 provenance。payload 和首次生成的 provenance manifest 一经提交不覆盖；`capture_scope_snapshot` 只说明抓取当时上下文，不授予当前访问权。有效授权唯一来自带审计历史的 `WikiAclStore`，索引重建不得从 snapshot 恢复 ACL。
   - 来源 trash/restore/purge 记录在独立 append-only lifecycle/tombstone store，当前 `lifecycle_state` 是“immutable manifest + 最新 lifecycle event”的投影；索引重建必须按该投影恢复，不能把 trashed 来源重新激活。privacy purge 可以删除含敏感定位的 manifest 和 payload，但要保留不含正文/路径/身份的 purge tombstone，阻止旧 staging/snapshot 复活内容。
   - 机器 provenance 和 blob 全部位于 `.lume/sources/`，不进入 Obsidian page/link 索引，避免大量同名/机器页面污染 Vault。用户可见的 `source` 页面仍位于 inbox/workspace 的 `sources/`，由 Lume inspector 打开对应原始 payload。
   - 网页保存抓取时的 Markdown、元数据和必要本地图片；聊天保存所选消息正文快照及 thread/message/run ID；本地文件保存摄入时副本。单个原件默认上限 25 MiB，超过上限或无法复制时保存哈希、原路径、抽取文本和 `external_only/extracted_only` 警告，不谎称已经完整归档。
   - Wiki 根目录可直接作为 Obsidian Vault 打开。桌面端通过官方 `obsidian://open?path=...` 形式提供可选「在 Obsidian 中打开」，失败时只提示安装/注册 URI；Lume 的读写、链接和搜索不得依赖 Obsidian 进程。

3. **定义可演化页面格式和内容所有权，保护用户编辑。**
   - 页面正文采用稳定章节：摘要、已知内容、用户批注、开放问题、相关页面。来源引用必须落到 `WikiSourceRef` 或原始聊天/文件定位；LLM 输出只能标记为综合内容，不能伪装成原始事实。
   - Agent 维护段落使用 Obsidian 可忽略的 HTML 注释记录 `block_id/owner/revision/source_ids/content_hash`；`用户批注` 默认 `owner=user`，任何自动流程都不得覆盖。
   - Lume 内直接编辑时记录实际变动的 block；外部编辑器修改后，由 watcher 对比最后提交快照：被用户改变的 Agent block 自动升级为 `owner=user`。如果标记被删除、页面解析失败或所有权无法判定，整页进入受保护状态，后续 Agent 改写必须审核，不能猜测恢复标记。
   - 页面文件使用唯一且不变的 basename `file_key`，Wiki link 写成 `[[file_key|当前标题]]`，因此改 `title/aliases` 或在 inbox/workspace/archived 之间移动不改变链接目标。首版禁止 Lume 自动重命名 basename；外部重命名只在全库扫描确认旧 basename 零入链后作为高风险变更接受，否则保护页面并生成 finding。发现重复 ID/file_key、无法解析的链接或同名歧义时不静默选择目标。
   - 用户可编辑整篇 Markdown和元数据表单，也可要求 Lume 拆分、合并、补充或重写；删除、合并、覆盖用户拥有内容始终属于高风险草案。

4. **用带前置条件的操作批次保证多文件更新、撤销和外部编辑并存。**
   - 在 `apps/sidecar/src/services/wiki/` 增加单一逻辑入口 `WikiMutationCoordinator`，所有 UI 保存、导入确认、Agent 变更和 lint 修复都经过它；同时使用跨进程 lock file 覆盖短暂双 sidecar 重叠。锁包含 owner PID、定期 heartbeat 和单调递增 fencing token；只有确认 owner 已死亡才能接管，不能只因 wall-clock lease 超时接管仍存活 writer。每次 journal 写入和文件 replace 都校验 token，失去 token 的 writer 立即停止。不要让各 RPC handler 或工具直接写 Markdown。
   - 草案必须列出每个目标的 `beforeHash`、创建/修改/移动/删除操作、来源、风险原因和预览 diff。确认时重新校验 hash；任何页面被用户或 Obsidian 改过都拒绝原草案并要求重新生成，防止丢失更新。
   - 多文件提交使用 `prepared -> applying -> committed` journal、同文件系统 staging、逐文件原子替换和 before/after snapshots。每个替换和恢复步骤都重新校验 `beforeHash/afterHash`；若当前值是第三种 hash（包括 Lume 停机期间的 Obsidian 编辑），立即停止恢复、保护该页并送审，禁止盲目完成或回滚。
   - 正常的新建、Agent 管理区增量更新、索引和机械链接修复在用户确认收录后作为一个批次直接应用；删除页面、覆盖用户内容、冲突合并、低置信度归并和永久删除进入 `.lume/pending/`。
   - 撤销只有在当前文件 hash 仍等于该批次 `afterHash` 时直接执行；否则生成逆向草案进入审核，避免撤销覆盖后续编辑。新来源在撤销后若无人引用先进入 trash，不立即物理删除。
   - 操作日志追加记录批次发起者、来源、风险、时间、受影响 ID 和结果，但不复制完整敏感正文；完整恢复内容只存在本地 snapshots，并纳入数据清理/永久删除规则。

5. **实现显式导入和“沉淀到 Wiki”草案流程，不做后台自动摄入。**
   - 新增 source adapters：粘贴文本、URL/已有 WebFetch 资产、本地文件或文件夹、工作区文件、选中的聊天消息、读书笔记和显式选择的 Memory V2 entry。复用已有 WebFetch 的解析/Markdown 转换、reading store、Memory source open 和线程持久化读取能力；已有抓取资产可直接快照，不重复联网，但 URL 的网络传输不能沿用当前自动跟随重定向的实现。
   - 为 Wiki URL adapter 增加独立 `WikiSafeHttpFetchService`，使用 Node 内置 HTTP(S) 能力且不新增依赖：只允许 `http/https`，剥离 credentials；关闭自动重定向并逐跳校验协议、host、端口和重定向次数；每一跳重新解析 A/AAAA，拒绝 loopback、link-local、私网、保留地址和混合结果，并在建立连接时固定使用已校验地址（同时保留原 hostname 作为 TLS SNI/Host），避免 DNS rebinding。设置连接/总超时、最大响应字节和网页附件总额；首版不继承环境 HTTP(S) proxy，若某平台不能保证“校验地址即连接地址”或环境必须经代理，URL 导入 fail closed，只允许导入已有本地 WebFetch 资产。
   - 所有 adapter 共用其余摄入安全层：持久化 URL 时清除敏感 query；本地文件和 folder entry 使用 realpath containment，拒绝 symlink/junction 逃逸。限制单文件 25 MiB、单批次 250 MiB、最多 500 个文件、网页附件合计 100 MiB，超过时在确认单列出跳过项，不静默截断、递归越界或无限抓取。
   - Wiki 顶部提供一个明确的「导入」动作；聊天消息/助手结果、读书笔记、Memory 条目和文件菜单提供「沉淀到 Wiki」。不在升级、启动、每轮聊天结束或读书笔记生成后自动扫描和建页。
   - 导入先写有过期时间的 `.lume/staging/<draftId>`，生成轻量确认单：建议标题、页面类型、主要归属、关联工作区、来源和将新建/更新的页面。取消或过期只清 staging，不改变正式来源库和 Wiki。
   - 用户可修改标题与归属后一次确认批次。Agent 回答被收录时创建/更新 `synthesis`，并保留它引用的原始证据；没有原始证据的段落明确标为模型综合。聊天 provenance 固定记录 Lume `messageId/versionGroupId/versionIndex`、可选外部 IM message ID、抓取时间和正文 hash；后续编辑/重发创建新 provenance，不改写旧快照。
   - 内容 hash 先完成来源去重；页面候选再按稳定 ID、alias、标题、显式链接和相似度提出“更新现有/新建”建议。相似度只能提出候选，不能直接合并；歧义和冲突进入审核。
   - 现有 Memory、聊天、读书和资源数据不迁移、不改格式。首版唯一历史入口就是显式「导入」或各处「沉淀到 Wiki」。

6. **建立独立、可重建的全文/链接/语义索引。**
   - 使用运行时已有的 `node:sqlite` 和 FTS5 建立 Wiki 索引，不新增依赖。表至少覆盖 pages、page sections、source blobs、独立 provenance records、tags、workspace associations、links、aliases、source citations、revisions 和 lint findings；索引位于 `.lume/index/`，不是事实来源。
   - 正式批次先提交 Markdown/journal，再增量更新索引并写 generation。索引失败不能回滚已经安全提交的知识文件；应标记 stale，并在下次启动/搜索时根据 Markdown 和 source manifests 完整重建。
   - 复用 Memory V2 已有的 embedding provider、local ONNX、rerank 和向量数学能力，但建立 Wiki 专属增量 embedding cache，key 为 `modelKey + blockContentHash`。不要复用 Memory 当前“任一文件变化就重建全部 JSON embeddings”的索引实现。
   - 启动时探测 FTS5 trigram tokenizer；支持时对标题、alias 和正文建立 trigram FTS，缺失时建立确定性的 CJK 2/3-gram 辅助表，不能对整个语料退化为无界 `%LIKE%`。`wiki.search` 先执行作用域/权限过滤，再组合中文/英文 lexical、标题/alias、链接邻域和可选语义结果，使用确定性融合后只对 top candidates rerank。默认检索当前 workspace UUID 的主要归属和关联页面；inbox 只对桌面本地用户或显式 inbox scope 可见，“全部 Wiki”必须明确给出。
   - `wiki.read` 返回页面、受限来源摘要和引用；访问每条 provenance record 时单独做主体与 scope 过滤，blob hash 相同不代表授权相同。事实性回答继续读取获准的不可变来源，不能只引用 Wiki 二手综合。`wiki.follow_links` 只遍历已经授权的页面，防止从一个允许页面跨到未授权文件夹。
   - 首版验收数据集按 5,000 个页面、50,000 个可搜索段落验证，并包含中文短词、混合中英文、标题/alias、inbox 与跨工作区授权样例；warm lexical search 目标低于 300 ms，未调用远程 rerank 的本地 hybrid search 目标低于 2 s。模型下载和远程供应商延迟单独展示。

7. **接入 Agent runtime，但把正式写入权留在用户确认边界。**
   - 在 `apps/sidecar/src/services/agent-runtime/tools/wiki/` 增加 `wiki.search`、`wiki.read`、`wiki.follow_links` 和 `wiki.propose_changes`，接入 `create-lume-tools.ts`、sidecar/web tool metadata 与权限设置。
   - 前三个是只读工具；`wiki.propose_changes` 只能创建 staging draft 并返回确认卡所需数据。不得向模型暴露绕过确认的 `wiki.apply` 或任意 Wiki 文件写工具。sidecar 保存不可变 draft；apply/resolve/undo RPC 只接收 `draftId + expectedRevision + sidecar 签发的一次性确认 nonce`，绝不接受 renderer 提交的路径、diff 或操作列表，nonce 使用后或过期后失效。
   - Wiki 根是 Agent runtime 的受保护域，而不是普通 `privateWriteRoot`：在 permission mode、用户 allow rule 和 session bypass 之前，tool execution gateway 必须拒绝通用 `Read/Write/Edit/Glob/Grep`、文件移动/删除、node-repl、MCP 文件工具及 shell 对 Wiki 根的直接访问，只有 Wiki service capability 可读写。`bypassPermissions` 不能绕过该 gate。
   - 对 Bash/node-repl 等不透明命令执行器，完整能力发布前必须具备可验证的允许根沙箱，使进程只看到当前项目、线程文件上下文和用户显式挂载目录，中央 Wiki 根不在 mount/allowlist 中。仅靠命令字符串匹配或隐藏路径不算完成；不能为了 Wiki 让普通编码会话在某个平台静默失去 Bash 等核心工具。
   - 用明确的 capability matrix 分两阶段发布：Phase A 允许 Wiki UI 通过 coordinator 导入/编辑，并允许从 Wiki 打开的专用 Ask Wiki 会话调用 `wiki.search/read/follow_links`；该会话复用普通聊天 UI、历史和工具调用展示，但使用 sidecar 固定的只读 Wiki tool profile，不带通用文件工具、Bash/node-repl 或 `wiki.propose_changes`。普通 Agent 会话不自动附加 Wiki scope，也不获得 Wiki tools，因此原有编码能力不受影响。
   - Phase B 只有在当前平台的 protected-root gate、允许根沙箱和兼容性测试全部通过后才开启：普通桌面直接会话可默认按当前 workspace UUID 获得 Wiki 只读检索，显式 Wiki-scoped 会话可使用 `wiki.propose_changes`。未通过的平台永久保持 Phase A 并显示能力说明，不以删减普通会话核心工具作为降级方案。
   - 普通对话永不预加载整座 Wiki，Phase B 也只按问题调用工具。“向 Wiki 提问”写入由 sidecar 校验的 scope attachment（当前页面、文件夹、工作区或全部 Wiki）；Phase A/Phase B 的 profile 选择完全由受信任的启动入口和平台能力决定，renderer 不能把普通会话自行升级为 Wiki-scoped profile。
   - 在 sidecar 建立持久化 `WikiAclStore`。主体从受信任的 thread source、IM account/thread binding 和 workspace UUID 推导；renderer 传入的 `chatType/workspace/scope attachment` 只是请求，必须由 sidecar 与线程元数据复核，不能作为授权事实。桌面直接会话默认只读当前 workspace UUID；inbox、全部 Wiki 和跨工作区需要显式 scope。IM 私聊默认无授权，群聊/频道默认禁用；授权只能绑定特定 workspace UUID，不能给外部渠道开放全库。过滤必须发生在搜索、读取、rerank 和 prompt assembly 之前。
   - 页面范围与来源授权是两个串联 gate：可信主体先得到 workspace scope；页面只有在其 `primary_workspace_id/associated_workspace_ids` 命中 scope 时可见；原始 provenance 还必须拥有同一 workspace UUID 的有效 source grant 才可读。桌面本地 owner UI 可管理全库，但 Agent/IM 检索不能借此绕过。确定状态转换如下：

     | 操作 | 页面范围变化 | provenance source grant 变化 |
     | --- | --- | --- |
     | import | 创建 primary/inbox 与用户选择的 associations | 确认卡单独列出来源 grant；默认只建议 primary workspace，inbox 仅本地 owner；其他 workspace 必须显式勾选 |
     | associate | 增加页面 association | 不隐式增加；需要在同一确认卡中另做 explicit grant |
     | disassociate | 移除页面 association | 不隐式撤销已有 grant；确认卡显示遗留 grant，可同时 explicit revoke |
     | rehome | 修改 primary 并保留/调整 associations | 不隐式迁移；若新 primary 无 grant，显示“页面可见但原始来源不可下钻”，可在同批次 explicit grant/revoke |
     | archive workspace | 页面移到 archived 且原 workspace scope 失活 | 为该 workspace UUID 追加 revoke events，不能因同 slug 新工作区恢复 |
     | explicit grant/revoke | 不改变页面归属 | 按 provenance 或经影响预览的批次追加 ACL event；revoke 对后续检索立即生效 |

   - 页面 association 本身不能作为来源授权证据；确认卡必须分别展示“谁能看到页面”和“谁能读取每个原始来源”。事实回答若无法通过 provenance gate 下钻，必须明确标记来源受限，而不是用页面综合伪装成已验证事实。
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
   - 增加手动「检查 Wiki」和每周 due-check：打开 Wiki 或 sidecar 启动后发现距上次成功语义检查超过 7 天时，只排队一次后台 job。复用现有通用 automation job runner 的状态/互斥能力或建立 Wiki 内部 due-check，不接入固定每日 8 点、一次性 activity 的 routine runner。没有可用模型时只运行结构检查，并明确显示语义检查未执行。
   - 语义 lint 检查疑似冲突、陈旧结论、近似重复、缺失主题页和知识空白，只写待审核 findings，不自动搜索外网、不自动重写页面。它可建议应该调查的问题和来源，但由用户决定是否搜索/导入。
   - 任务记录 last successful generation、模型、范围、耗时和 finding counts，失败可重试且不会阻塞读取；同一 generation 不重复运行。用户可以关闭周期性语义检查或手动触发，但结构检查不可关闭。

10. **处理工作区生命周期、删除、导出和彻底清除。**
    - Wiki 位于中央根目录，删除 Lume 工作区不得被 `deleteAgentWorkspaceInternalData` 级联删除。改造 `agent-project-lifecycle-service.removeProject`：在 drain 后、停用 automation/清理绑定/线程转换/内部目录删除之前，先用 workspace UUID 执行 Wiki preflight 和可恢复逻辑归档批次，把目录移动到 `archived-workspaces/<workspace-id>--<slug-snapshot>/` 并写 journal；归档失败则整个 project removal fail closed。后续 destructive sequence 失败时保留已归档 Wiki 和 journal 供重试，不尝试跨服务伪事务或恢复旧 ACL。
    - 归档页面仍可在全部 Wiki 搜索中找到，可重新指定主要归宿。被其他页面关联的来源或页面删除时先计算影响；普通删除进入 Wiki trash，永久删除需要二次确认和批次审核。
    - 删除原聊天、读书笔记、工作区资源或本地原文件不级联删除已经明确沉淀的 Wiki 快照。相应删除 UI 在可判定时提示“内容已独立归档到 Wiki”。
    - 增加 Wiki 专属隐私清除：按 page/source/thread/message/workspace 追踪引用并展示影响。普通清除先删除选中的 provenance、由它独占支撑的派生 blocks、索引、staging、snapshots 和 operation 正文恢复数据，再重新计算 blob 的存活 provenance 引用数；只有引用数为零才 GC payload，并留下不含正文的 tombstone，防止重建时复活。若用户要求按 content hash 强制清除共享 payload，必须先预览所有引用该 hash 的 provenance 和页面，并在二次确认后一起删除全部引用，不能让一个私聊来源的清除误删仍被其他合法来源使用的共享 blob。
    - 扩展数据管理统计、全量导出和清理边界：Wiki Markdown 与来源默认随用户数据导出；SQLite/embedding index 是可重建缓存；普通缓存清理不能删除 Wiki、来源、版本或待审核项。

11. **用针对性测试证明边界，而不是新增一套泛化框架。**
    - Shared/sidecar 单元测试覆盖 schema、`primary_workspace_id=null` inbox、UUID/slug 复用、路径逃逸、frontmatter round-trip、稳定 ID/file_key、title/alias、blob 去重但 provenance/ACL 不合并、capture/lifecycle 投影、所有权升级、风险分类、link resolution、CJK n-gram/trigram 搜索和 lint rules。
    - Store/coordinator 集成测试覆盖：正常多页 ingest、确认前零正式写入、stale `beforeHash` 拒绝、外部编辑竞争、Windows junction/Unix symlink 的读逃逸与写逃逸、lock heartbeat、死亡 owner 接管、旧 writer fencing 失败、journal 中断恢复、索引失败后重建、trash 后重建不复活、ACL 重建不读取 capture snapshot、页面 scope/source grant 状态表、撤销前置条件、共享 blob 的引用计数/强制清除影响分析和工作区归档不丢知识。
    - Agent/tool/security 测试证明 read tools 先做 scope/provenance filter、`wiki.propose_changes` 不写正式库、renderer 无法伪造 apply payload/nonce、没有模型可调用 apply、IM/group 默认无访问、引用会下钻到来源；对 `default/acceptEdits/dontAsk/bypassPermissions` 全部验证 protected root 不可绕过。capability matrix 测试还要证明 Phase A 普通编码会话保留原工具但没有 Wiki scope，Ask Wiki 只有固定只读 profile，Phase B 只在平台 gate/sandbox 验证成功后启用。
    - Wiki Safe HTTP 测试覆盖每跳重定向校验、IPv4/IPv6 私网与保留地址、公开域名重定向到内网、混合 DNS 结果、DNS rebinding、TLS SNI/Host、响应大小、超时和代理环境 fail-closed；现有 WebFetch 行为不在本任务中变更。
    - Web 状态/交互测试覆盖 Lume 三个功能切换、导入确认、Markdown 保存冲突、待审核、inspector、Ask Wiki scope 和 Wiki 引用定位。只对可测试逻辑运行相关测试；不因纯样式调整执行全量 test/lint/typecheck。
    - 增加一个小型端到端 fixture：导入两份相互矛盾的来源，创建 topic + synthesis，用户修改一段，第二次 ingest 只能自动更新 Agent 区并把冲突/用户覆盖送审；删除工作区后页面仍在 archived-workspaces，可搜索、可撤销、可用 Obsidian 打开。

12. **以最小迁移和可回滚方式发布。**
    - 首次进入 Wiki 才创建目录和索引；已有用户看到空 Wiki 和「导入」动作，不执行 Memory/聊天/读书后台迁移。
    - 不新增依赖；优先复用 `node:sqlite`、现有 Markdown/预览组件、WebFetch 的内容解析层与已有本地资产、Memory embedding/rerank adapters、automation job 状态、原子写和 watcher 模式。首版只为 Wiki URL adapter 增加安全传输；迁移现有 WebFetch transport 需另立兼容代理/内网页面和回归测试的任务。
    - 实施时保留当前工作树中 `ReadingView`、侧栏和 reading service 的用户改动，先检查重叠 diff，再做局部修改；不要顺手整理无关 UI 或 Memory V2。
    - 每个实施提交遵循仓库 Lore 协议，按 shared/sidecar/web/desktop 边界保持可审阅；功能未完整接通前不把未使用的 Wiki tool 暴露给模型。

## Key decisions & tradeoffs

- **独立统一 Wiki，而非每个工作区一座库。** workspace UUID 是归宿和权限身份，slug 只展示；一个页面只有一个物理归宿，可关联多个工作区，`primary_workspace_id=null` 表示 inbox。
- **Wiki 与 Memory V2 分离。** 两者复用底层检索能力，但语义、存储、索引和权限独立，只允许用户显式提升，不做自动双向同步。
- **显式沉淀优先。** 用户发起导入/沉淀，Agent 只建议；没有普通聊天、读书或启动时的静默自动摄入。
- **来源不可变，Wiki 可演化。** 来源事实、模型综合和用户批注明确分层；事实回答应下钻原始来源。
- **正常批次自动应用，高风险送审。** 用户确认收录后不逐文件确认，但覆盖用户内容、删除、冲突和低置信度合并必须审核；所有提交可查看 diff，并在前置条件成立时撤销。
- **Lume 原生，Obsidian 可选。** Markdown/Wiki links/frontmatter 保持 Vault 兼容，但不依赖 Obsidian、插件、Sync 或 Publish。
- **Markdown 编辑而非块编辑器。** 首版提供渲染阅读、Markdown 编辑、元数据表单和自然语言修改；用 block ownership 保护用户编辑。
- **问答复用聊天 UI/runtime，但使用分阶段 capability profile。** Phase A 只有专用 Ask Wiki 只读会话能检索 Wiki，普通编码会话不附加 Wiki；Phase B 在平台隔离验收后才开放普通会话按当前 workspace 检索和 `wiki.propose_changes`，不重复建设聊天产品。
- **本地单用户首版。** 不处理云同步、多人实时编辑、组织 ACL 或合并冲突服务；仍需处理 Obsidian 等外部本地编辑造成的并发。
- **不做原生图谱。** 首版以双向链接、反向链接、相关页面和 lint 提供结构；需要节点图时可用 Obsidian。
- **不复用线程右侧面板。** 当前面板只支持 agent thread；Wiki 使用功能页内 inspector，避免把本任务扩大为全局面板架构重写。
- **不自动迁移。** 只增加显式「导入」和「沉淀到 Wiki」，现有 Memory/聊天/读书/资源格式保持不变。
- **确认 RPC 不接受客户端草案。** renderer 只能提交 sidecar draft ID、revision 和一次性 nonce；正式操作始终从 sidecar 保存的不可变草案加载。
- **Wiki 根是不可绕过的 Agent protected root。** 通用文件/命令工具不能直接读写；平台隔离未通过时保持 Phase A，而不是让普通编码会话失去核心工具。
- **Wiki URL 抓取使用逐跳、固定地址的安全传输。** 不改变现有 WebFetch transport；无法保证 DNS 校验结果与实际连接地址一致或必须经过环境代理时，Wiki 联网导入 fail closed。

## Risks / open questions

- **外部 Markdown 编辑可能破坏标记或链接。** 通过稳定 ID、hash 前置条件、watcher、alias 和“无法判定即保护整页”处理；不尝试无证据的自动修复。
- **Obsidian 可见目录与 Agent 通用 shell 的隔离限制完整能力。** Phase A 通过专用只读 Ask Wiki profile 避开不透明工具；Phase B 以 protected-root gate 和允许根沙箱为发布门槛。平台未达标时功能停在 Phase A，不影响普通编码会话。
- **安全 URL 抓取是独立安全工作。** 逐跳解析、地址固定和响应限额需要覆盖 IPv4/IPv6、重定向与 DNS rebinding；实现若无法证明校验与连接一致，只接受已有本地抓取资产。
- **页面可见不等于原始来源可见。** 两层 gate 和显式 grant 状态表避免跨工作区泄露，但也可能让重新归属后的页面暂时无法下钻；UI 必须把受限来源状态展示出来。
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
