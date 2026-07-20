# Lume Wiki 知识域

本上下文定义 Lume 中可长期维护知识的统一语言。Wiki 独立于工作区和 Memory；工作区只提供页面归宿与访问范围，不拥有 Wiki 数据。

## Language

**Wiki 页面（Wiki Page）**：
Wiki 中可独立演化的 Markdown 知识单元，拥有稳定标识和文件键。页面可以归入工作区，也可以暂存于收件箱。
_Avoid_: Memory 条目、工作区文件、知识文件

**工作区归宿（Workspace Home）**：
Wiki 页面的主要组织位置，由一个工作区 UUID 表示。它不是数据所有权或原始来源权限；同一页面还可以关联其他工作区。
_Avoid_: Wiki 所有者、工作区 Wiki

**收件箱（Inbox）**：
尚未指定工作区归宿的 Wiki 页面集合，语义上等同于 `primary_workspace_id = null`，不是一个隐含工作区。
_Avoid_: 默认工作区、全局工作区

**页面范围（Page Scope）**：
决定某次会话能否检索或读取页面的可见性边界。页面范围与原始来源权限相互独立，不能由其中一个推导另一个。
_Avoid_: 来源权限、全库权限

**来源快照（Source Snapshot）**：
导入时冻结的原始材料及其内容哈希。快照不可被后续同步覆盖；删除或失效通过生命周期事件表达。
_Avoid_: Wiki 页面、当前外部文件

**来源记录（Provenance Record）**：
描述一次采集行为的不可变记录，包括来源类型、外部标识、采集时间和采集主体。多个来源记录可以引用同一份按内容寻址的来源快照。
_Avoid_: 来源授权、共享来源身份

**来源授权（Source Grant）**：
允许特定工作区 UUID 读取某条来源记录及其原始快照的显式授权。能读取 Wiki 页面不代表当前页面范围对应的工作区拥有来源授权。
_Avoid_: 页面范围、快照上下文

**受保护页面（Protected Page）**：
因用户拥有内容、外部编辑、标记损坏或无法可靠判断所有权而不能被 Agent 自动改写的页面。保护状态不影响用户读取或手工编辑。
_Avoid_: 只读页面、归档页面

**变更草案（Change Draft）**：
尚未进入正式 Wiki 的不可变拟议操作集合，包含创建者、作用域、预期基线和风险。草案必须经风险判定与必要的 owner UI 确认后才能提交。
_Avoid_: 已保存页面、模型回复、待发送消息

**待确认（Pending Review）**：
因高风险、冲突或权限边界而等待本地 owner 处理的草案状态。它不是已完成的 Wiki 写入。
_Avoid_: 已确认、写入中

**已提交批次（Committed Batch）**：
通过统一变更协调器原子提交的一组 Wiki 操作，是审计、撤销和恢复的基本单位。
_Avoid_: 单个文件写入、草案

**Wiki 会话（Ask Wiki Session）**：
从 Wiki 功能页进入、受固定知识范围和受保护工具约束的专用会话。它不自动获得普通工作区工具或原始来源权限。
_Avoid_: 普通 Agent 会话、全库管理员会话

**本地 Owner UI（Local Owner UI）**：
首版本地单用户产品中受信任的 Lume renderer 界面，可以选择 Wiki 范围并发起正式确认。Agent runtime、工具调用、网页内容、外部消息和它们可启动的子进程均不是本地 Owner UI。
_Avoid_: Agent、模型、任意 renderer 脚本

**确认边界（Confirmation Boundary）**：
把变更草案提交为正式 Wiki 的边界。只有本地 Owner UI 经 Agent 执行通道不可访问的桌面主进程 IPC 才能跨越该边界；草案 nonce 只用于不可变性、过期和防重放，不代表用户意图。
_Avoid_: nonce 校验、模型同意、工具成功

**Memory**：
面向助手个性化与跨会话提示的记忆域。Memory 可以作为明确导入的来源，但不能自动等同于或静默写入 Wiki。
_Avoid_: Wiki、长期知识库
