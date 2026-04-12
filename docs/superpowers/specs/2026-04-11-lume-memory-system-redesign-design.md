# Lume 记忆系统重设计

- 日期: 2026-04-11
- 主题: Lume 记忆系统重新设计
- 状态: 已确认，待进入 implementation plan

## 1. 目标

Lume 需要一套更稳定、更可解释、更贴近 workspace 语义的记忆系统。

新的记忆系统必须同时满足：

1. 用户能理解记忆存在哪里
2. agent 知道应该把什么写到哪一层
3. 长期记忆不会被短期噪音淹没
4. 检索层可以继续强，但不成为唯一真相源
5. 系统支持定期蒸馏，而不是只会不断堆积

## 2. 核心设计原则

### 2.1 记忆主语是双层的

Lume 的记忆不是单纯“关于用户的数据”，也不是纯“流水账经历”。

它应同时包含两类内容：

1. 用户稳定事实 / 偏好
2. Lume 与用户在特定 workspace 内共同形成的长期知识

因此记忆体系必须是分层的，而不是单一文件承载一切。

### 2.2 文件是真相源，数据库是派生层

文件层是人类可读、可编辑、可审查的真相源。

数据库、embedding、hybrid search 只是派生索引层，用于：

1. 检索
2. 排序
3. 召回

它们不能成为唯一真相源。

### 2.3 长期记忆必须克制

长期记忆不是“把所有东西都存进去”。

它应该越来越精炼、越来越稳定，而不是越来越长。

默认原则：

1. 新内容先进入短期层
2. 长期层更新由蒸馏决定，而不是直接无差别追加
3. 蒸馏任务负责提纯，不负责扩写流水账

### 2.4 必须全链路切换，不能留下旧记忆模型残留

这次记忆系统重构不是“新增一套更好的记忆层”，而是要替换当前旧模型。

要求：

1. 新旧两套记忆语义不能长期并存
2. 旧 recall 路径、旧写入规则、旧兼容分支必须明确移除
3. 旧残留文件如果不再属于新模型，要么迁移，要么删除，要么降级为一次性迁移输入
4. 最终 agent 只能面对一套统一记忆结构

不接受：

1. 旧 MEMORY 规则继续偷偷生效
2. 旧 sqlite / 文件路径继续被某些工具分支单独读取
3. 表面上完成 redesign，实际上 runtime 里还保留旧行为

## 3. 记忆层次模型

记忆系统采用三层主记忆 + 一层派生索引：

1. 全局记忆
2. workspace 记忆
3. thread 记忆
4. 派生索引层

## 4. 落盘结构

### 4.1 全局层

- `~/.lume/MEMORY.md`

作用：

1. 用户跨 workspace 的稳定偏好
2. 用户长期习惯
3. 跨项目仍然成立的身份与协作规则

全局层不记录日期日志，不记录流水经历。

### 4.2 workspace 层

- `<workspace>/MEMORY.md`
- `<workspace>/memory/YYYY-MM-DD.md`
- `<workspace>/.context/note.md`

语义：

- `MEMORY.md`
  当前 workspace 的长期记忆主文件

- `memory/YYYY-MM-DD.md`
  当前 workspace 的短期日记忆入口，先写这里，再决定是否晋升

- `.context/note.md`
  当前 workspace 的结构化长期工作笔记，偏分析、研究、方案，而不是偏好记忆本身

### 4.3 thread 层

- `<workspace>/threads/<thread-id>/.context/note.md`
- `<workspace>/threads/<thread-id>/.context/todo.md`

语义：

- thread `.context/note.md`
  当前任务的临时分析、上下文、阶段性结论

- thread `.context/todo.md`
  当前任务执行进度，不属于长期记忆

thread 层默认不是长期记忆，除非后续蒸馏时被晋升。

### 4.4 派生索引层

- `<workspace>/.meta/memory.sqlite`
- 可选全局索引：`~/.lume/.meta/memory.sqlite`

索引层用于：

1. embedding
2. hybrid search
3. 快速 recall

索引层不是用户直接编辑入口。

## 5. 各层的职责边界

### 5.1 全局 `~/.lume/MEMORY.md`

适合记录：

1. 用户长期模型偏好
2. 用户长期交互风格偏好
3. 跨多个 workspace 都成立的协作习惯
4. 对 Lume 的长期期望与稳定规则

不适合记录：

1. 某个项目特有的架构约定
2. 某个任务的一次性讨论
3. 带日期的经历流水

### 5.2 workspace `MEMORY.md`

适合记录：

1. 当前项目长期有效的架构知识
2. 反复踩过的坑
3. 项目内稳定约定
4. 与该 workspace 强绑定的共同经历总结

不适合记录：

1. 当前 thread 的中间推理过程
2. 一次性的调试日志
3. 临时待办

### 5.3 workspace `memory/YYYY-MM-DD.md`

适合记录：

1. 当天产生的短期记忆
2. 当天完成的重要任务摘要
3. 当天新增的用户偏好或项目结论

这是短期层，不是最终长期层。

### 5.4 thread `.context`

适合记录：

1. 当前任务的研究输出
2. 当前任务的执行拆解
3. 当前任务临时上下文

thread 层默认不进入长期记忆，除非后续蒸馏判断值得晋升。

## 6. 记忆写入流程

### 6.1 默认写入顺序

新信息默认先写入短期层，而不是直接写长期层。

优先顺序：

1. thread `.context/note.md`
2. workspace `memory/YYYY-MM-DD.md`
3. 经过 LLM 蒸馏后再进入 workspace `MEMORY.md`
4. 只有跨 workspace 稳定偏好才进入全局 `~/.lume/MEMORY.md`

### 6.2 什么值得立即进入 workspace 当日记忆

以下内容可以立即写入 `<workspace>/memory/YYYY-MM-DD.md`：

1. 用户明确表达的新偏好
2. 完成的重要任务结论
3. 对当前项目有复用价值的新知识
4. 当天形成的重要约定

### 6.3 什么不能直接进入长期层

以下内容不应直接进入 `MEMORY.md`：

1. 一次性调试细节
2. 临时方案比较中的中间过程
3. 当天才出现、尚未验证是否稳定的信息
4. thread 级待办

## 7. 晋升规则

### 7.1 从短期层晋升到 workspace `MEMORY.md`

这一步不再由规则直接决定，而是由 sidecar 内部 LLM 蒸馏服务判断。

蒸馏判断会综合：

1. 最近短期记忆
2. 最近 thread note
3. 当前 workspace 长期记忆
4. 当前全局长期记忆

来决定哪些内容值得进入 workspace `MEMORY.md`。

### 7.2 从 workspace `MEMORY.md` 晋升到全局 `~/.lume/MEMORY.md`

这一步同样由 sidecar 内部 LLM 蒸馏服务判断。

只有当某条结论明显：

1. 跨多个 workspace 都成立
2. 更像用户长期偏好，而不是项目偏好
3. 对未来多个 workspace 都有指导意义

时，才允许上浮到 `~/.lume/MEMORY.md`。

## 8. 检索顺序

默认 recall 顺序建议为：

1. 当前 thread `.context/note.md`
2. 当前 workspace 当日 `memory/YYYY-MM-DD.md`
3. 当前 workspace `MEMORY.md`
4. 全局 `~/.lume/MEMORY.md`

检索原则：

1. 越靠近当前任务的层级优先级越高
2. 长期层主要用于稳定背景，不抢占短期上下文

## 9. 定期蒸馏任务

### 9.1 必须存在蒸馏机制

记忆系统必须有定期蒸馏任务。

否则短期记忆只会不断堆积，长期记忆也会逐渐失去密度。

### 9.2 蒸馏粒度

蒸馏任务按 workspace 运行，并允许上浮到全局记忆。

也就是：

1. 每个 workspace 各自蒸馏
2. 必要时从多个 workspace 中归纳跨项目稳定偏好
3. 最终更新 `~/.lume/MEMORY.md`

### 9.3 蒸馏任务读取范围

蒸馏时默认读取：

1. 最近 `7` 天的 `<workspace>/memory/YYYY-MM-DD.md`
2. 最近 `20` 个活跃 thread 的 `.context/note.md`
3. 当前 `<workspace>/MEMORY.md`
4. 当前 `~/.lume/MEMORY.md`

这是增量窗口，不是全量历史重扫。

### 9.4 蒸馏任务写入范围

蒸馏时可写：

1. `~/.lume/MEMORY.md`
2. `<workspace>/MEMORY.md`

不应写：

1. thread `.context/todo.md`
2. thread 临时 note 的原文回写
3. 大规模重写 daily memory 历史文件

### 9.5 蒸馏任务职责

蒸馏任务负责：

1. 用 LLM 总结并判断哪些短期内容值得沉淀
2. 输出结构化提炼结果，而不是直接整篇重写长期记忆
3. 将 workspace 长期记忆与全局长期记忆分层更新
4. 压缩长期记忆长度

它不负责：

1. 扩写记忆
2. 重建流水账
3. 把所有短期内容无差别复制到长期层
4. 直接覆盖整个 `MEMORY.md`

### 9.6 蒸馏输出格式

LLM 蒸馏不直接返回整篇长期记忆，而返回结构化结果，例如：

```json
{
  "workspace_additions": [
    "项目里长期应遵守的稳定规则 A"
  ],
  "global_additions": [
    "用户跨项目都偏好简洁技术回答"
  ],
  "discarded_patterns": [
    "一次性调试过程，不应进入长期记忆"
  ],
  "summary": "本轮提炼出 1 条 workspace 长期记忆，1 条全局偏好。"
}
```

sidecar 负责：

1. 调用 LLM
2. 校验结构化结果
3. 去重
4. 安全写回 `MEMORY.md`

因此长期记忆的写回边界仍由 sidecar 控制。

## 10. 与现有实现的映射

当前已有：

1. `memory-search`
2. `memory-get`
3. `memory-save`
4. `memory.sqlite`
5. embedding / hybrid search

新的设计要求这些能力继续存在，但职责更清晰：

1. 文件层负责真相源
2. sqlite / embedding 负责派生索引
3. recall 顺序与写入晋升规则必须统一

## 11. 错误与退化策略

### 11.1 索引层失败

如果 sqlite / embedding / hybrid search 出错：

1. 文件层仍然可读
2. recall 可以退化为文件检索
3. 不能因为索引失败就丢失记忆主数据

### 11.2 蒸馏失败

如果蒸馏任务失败：

1. 原始短期记忆文件保留
2. 不应破坏现有长期记忆
3. 下次任务可继续重试

## 12. V1 最小落地范围

V1 需要完成：

1. 明确三层记忆落盘结构
2. 对齐 recall 顺序
3. 对齐写入顺序
4. 把长期层与短期层职责分开
5. 用 sidecar 内部 LLM 蒸馏替代规则蒸馏
6. 新增定期蒸馏任务设计入口
7. 明确旧记忆链路的迁移与移除清单

V1 不要求：

1. 一次性彻底重写 embedding 系统
2. 一次性重做所有 recall 算法
3. 一次性做复杂知识图谱

## 14. 迁移与清理要求

### 14.1 一次性切换

本次改造采用一次性迁移策略：

1. 迁移完成后，旧记忆模型立即退役
2. 不保留长期兼容层
3. 不允许新写入继续流入旧结构

### 14.2 必须清理的残留

实施时必须逐项确认：

1. 旧 memory recall 顺序是否还存在隐藏分支
2. 旧 memory save 是否还在写旧路径
3. 旧 sqlite 索引是否还绑定旧文件结构
4. prompt / MCP / tool 文案是否仍在描述旧记忆模型
5. 定时任务是否仍在跑旧记忆逻辑

### 14.3 最终状态标准

最终完成状态必须满足：

1. 只有一套对外可解释的记忆模型
2. agent 的 prompt、tool、文件路径、蒸馏任务都使用同一套结构
3. 删除旧逻辑后，系统仍可端到端工作

## 13. 预期收益

完成后，Lume 的记忆系统会具备以下特征：

1. 用户知道全局记忆和 workspace 记忆分别在哪里
2. agent 知道先写短期层，再决定是否晋升
3. 长期记忆更稳定、更短、更像真正的记忆
4. recall 更贴近当前任务，而不是混成一锅
5. 定期蒸馏可以持续提升记忆质量
