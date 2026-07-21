---
name: "Wiki 知识库"
description: "通过默认可用的受保护 Wiki 工具检索知识，或为用户明确要求沉淀的内容创建待确认草案"
when_to_use: "当用户说「存到 Wiki」「归档到 Wiki」「记到知识库」「保存到 Wiki」「查询 Wiki」「整理知识库」时触发"
allowed_tools: ["wiki.search", "wiki.read", "wiki.follow_links", "wiki.propose_changes"]
version: "3.2"
---

## 安全边界

- Wiki 是受保护知识域，不能用 `Read`、`Write`、`Edit`、`Glob`、`Grep`、`Bash` 或任何通用文件工具直接访问。
- 不要探测 `~/.lume/wiki`，也不要把失败后的草稿写到 session、workspace 或其他目录冒充已沉淀。
- 正式写入必须经过 `wiki.propose_changes` 创建 sidecar staging 草案，再由用户点击确认卡。模型不能代替用户确认。
- `wiki.propose_changes` 出现在工具 schema 中不等于获得写入授权；security gate 未就绪或当前用户没有明确要求写入时不得创建草案，runtime 会在写 staging 前拒绝。
- `wiki.search`、`wiki.read`、`wiki.follow_links` 是受 scope 与 provenance ACL 约束的只读能力，在受信任的本地 Agent 线程中应正常可用；不要把读取误当成写权限。
- 当前运行没有某个 Wiki 工具时，只能说明“当前线程未获得该工具”，不得据此断言 Wiki、sidecar 或安装包整体不可用；不要改用文件写入兜底。
- `wiki.*` 是 Lume 运行时内置工具，不是 MCP server；MCP servers 列表为空不能用于判断 Wiki 是否可用，只能以当前工具 schema 中是否存在 `wiki.*` 为准。

## 操作一：沉淀内容

1. 先确认用户明确要求写入 Wiki，而不是只在讨论什么内容值得沉淀。
2. 提炼稳定、可复用的结论，保留必要上下文和不确定性；不要原样复制整段聊天。
3. 若 `wiki.search` / `wiki.read` 可用，先检查是否应更新已有页面。更新必须先读取页面，并向提案提供 `pageId` 与 `expectedHash`。
4. 若只有 `wiki.propose_changes` 可用，只能新建页面草案，不要猜测已有页面内容。
5. 调用 `wiki.propose_changes` 后，告诉用户草案尚未进入正式 Wiki，等待用户在确认卡中确认或取消。

页面类型：

- `topic`：长期维护的主题知识。
- `decision`：包含背景、选择、理由和后果的决策记录。
- `synthesis`：从对话或多条材料提炼出的综合结论；默认优先使用。

## 操作二：查询与整理

- 使用 `wiki.search` 找相关页面，`wiki.read` 读取页面与来源，必要时用 `wiki.follow_links` 沿链接扩展。
- 不要预加载整座 Wiki；按用户问题最小化检索。
- 发现矛盾、孤页、缺失引用或过时内容时可以提出整理建议；只有用户明确要求修改时才创建提案。
- 当前没有 Wiki 读取工具时，不得声称已经检查或整合了既有知识。先确认当前是否为普通旧线程；需要查询或维护既有页面时，引导用户从 Lume「Wiki → 向 Wiki 提问」新建受保护的 Wiki 专用会话，不要把当前线程缺少 schema 误报成系统级故障。

核心理念：**Wiki 不是文件存档，而是经过确认、可持续维护的知识。**
