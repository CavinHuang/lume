# Agent 消息附件设计

> 日期: 2026-05-18
> 状态: 已批准（对话确认）
> 分支: feat/new-ui

## 概述

为 Lume 增加“添加附件给 agent 解读或提供信息”的能力。第一版采用“线程保存 + 本轮绑定”模型：附件先保存到当前线程文件区，再随下一条用户消息绑定为本轮输入。这样既保留本地可追溯文件，也让 agent 明确知道本轮需要解读哪些附件。

这次设计不重做文件附加区。现有线程文件、工作区共享文件、外部附加元信息、paperclip、拖拽保存和 provider 图片附件适配都继续复用。新的重点是补齐“附件属于哪条用户消息，以及如何进入 agent runtime/context”的协议。

## 背景

当前实现已经具备一些基础：

- Web composer 有 paperclip 入口。
- Agent 主视图支持拖拽文件保存到线程。
- Sidecar 文件服务可以把外部文件复制进线程文件区。
- 文件侧栏可以展示线程文件和工作区共享文件。
- Provider adapter 已经有图片附件转多模态请求的能力。

但这些能力还没有形成完整闭环：

- 上传后的文件主要是线程资源，不是某条用户消息的明确输入。
- `AgentSendInput` 只有 `userMessage`，没有本轮附件引用。
- Runtime/context 无法稳定告诉 agent “请解读本轮这些文件”。
- 图片 adapter 能处理附件，但上游没有可靠绑定来源。
- 非图片文件缺少最小上下文策略，容易被保存后遗忘。

## 目标

- 用户可以在 composer 中添加多个附件，并随下一条消息发送。
- 附件保存到线程文件区，后续仍可在文件面板中查看和复用。
- 本轮发送时，附件引用进入 `AgentSendInput`，成为 runtime 可见输入。
- 图片附件作为多模态输入传给支持图片的 provider。
- 非图片附件以“附件清单 + 线程内路径”的形式进入上下文，让 agent 用现有文件工具读取。
- 保持 RPC handler 轻薄：只验证输入和委派，不拥有附件业务语义。
- 保持改动可逆，不引入新依赖。

## 非目标

- 不做云端上传。
- 不做 OCR、PDF 全文解析或 Office 文档解析。
- 不做附件长期索引或 embedding。
- 不把大文件全文自动塞进 prompt。
- 不新增全局资源数据库。
- 不重写文件侧栏或文件附加区。
- 不为所有历史线程回填附件绑定。

## 用户体验

### Composer pending 附件

用户点击 paperclip 或拖拽文件到当前 agent 视图后，文件进入 composer 的 pending 附件列表。

Pending 附件应展示：

- 文件名
- 文件大小
- 文件类型或简短类型标识
- 移除按钮

用户发送消息后：

1. Web 端保存 pending 文件到当前线程文件区。
2. 保存成功后，Web 端把保存后的附件引用随 `agentSend` 发送。
3. Pending 列表清空。
4. 用户消息在对话中展示附件摘要。

如果保存失败，不发送消息，保留 pending 附件并提示失败。

### 拖拽行为

主视图拖拽文件时，第一版应进入 composer pending 附件，而不是立即只保存为线程文件。这样拖拽与 paperclip 在语义上保持一致：都是“准备作为下一条消息输入”。

文件侧栏中的“附加到当前线程 / 工作区”仍保留原有资源管理语义，不自动绑定到下一条消息。

## 数据模型

新增共享类型：

```ts
interface AgentMessageAttachmentInput {
  id: string
  filename: string
  mediaType: string
  size: number
  threadPath: string
}
```

`AgentSendInput` 新增：

```ts
messageAttachments?: AgentMessageAttachmentInput[]
```

约束：

- `threadPath` 必须是线程文件区内的安全路径或相对路径。
- Web 端不传任意外部绝对路径给 runtime。
- Sidecar 需要在发送前解析并校验附件仍位于当前线程文件区。
- 附件引用只描述已保存文件，不承载 base64 数据。

`SAVE_FILES_TO_THREAD` 可继续返回 `targetPath`。Web 端应把返回结果映射为 `messageAttachments`，其中 `threadPath` 使用保存后的线程内路径。

## Runtime 边界

### RPC handler

`agent-handlers.ts` 只做：

- 校验 `messageAttachments` schema。
- 保持现有 plan approval / continuation 委派流程。
- 把输入传给 runtime orchestrator / agent service。

它不读取文件，不拼附件 prompt，不判断 provider 能力。

### Agent Runtime Kernel

Kernel 持有“本轮输入”的产品语义：

- 用户文本
- message metadata
- message attachments
- runtime event
- context assembly

附件绑定应成为本轮 run input 的一部分，并随用户消息版本 metadata 一起持久化，方便回放和调试。

### Context Assembler

Context assembler 负责把非图片附件变成最小上下文：

```text
本轮用户附加了以下文件：
- brief.md (text/markdown, 12 KB): files/brief.md
- screenshot.png (image/png, 420 KB): files/screenshot.png

请优先根据用户问题解读这些附件。文本或二进制文件需要更多细节时，使用文件读取工具访问对应路径。
```

原则：

- 清单要短。
- 不自动读取大文件全文。
- 文本文件第一版也只给路径，不做内容内联。
- 后续可以在 context budget 内增加小文本文件预览，但不属于第一版。

### Provider adapter

图片附件走已有 provider attachment 机制：

- OpenAI 兼容适配器转 `image_url`。
- Anthropic 适配器转 image content block。
- Google 适配器转 inline image part。

Provider adapter 不负责解析线程路径；它只接收 runtime 已解析、已验证的图片附件。

不支持图片的模型或 provider：

- 不阻止发送。
- 图片仍出现在附件清单中。
- Agent 可以通过文件工具查看路径或说明当前模型无法直接视觉解析。

## 消息与回放

用户消息版本 metadata 需要记录附件引用：

```ts
metadata: {
  messageAttachments: AgentMessageAttachmentInput[]
}
```

可见用户消息仍以文本为主，UI 从 metadata 渲染附件摘要。历史回放时：

- 文本对话不因附件缺失而崩溃。
- 如果附件文件还存在，runtime 可继续解析。
- 如果附件文件被删除，runtime 在上下文清单中标记缺失，或发送前给出错误。

第一版建议发送时强校验存在性；历史展示则容错。

## UI 展示

### Composer

附件 chip 放在输入框下沿或工具栏上方，保持紧凑：

- 文件名超过宽度时截断。
- 移除按钮用 icon。
- 图片可选小缩略图，但不是第一版必需。

发送按钮可在只有附件无文本时启用。发送文本建议默认为空字符串或自动提示：

```text
请解读这些附件。
```

推荐第一版允许“仅附件发送”，由 web 端在 `userMessage` 为空时填入这句默认文本，避免后端到处处理空消息。

### 消息列表

用户消息下方展示附件摘要：

- 文件名
- 类型/大小
- 点击可打开右侧文件预览

这只是展示层，不是新的文件来源。

## 错误处理

- 文件保存失败：不发送消息，toast 提示，pending 附件保留。
- 附件路径校验失败：sidecar 拒绝发送，返回明确错误。
- 附件已删除：发送前拒绝；历史展示时显示缺失状态。
- 图片读取失败：本轮降级为清单路径，并记录 runtime warning。
- 文件过大：允许保存，但不自动内联；如超过本地复制限制则沿用文件服务错误。

## 验证

需要覆盖的可测试逻辑：

- `AgentSendInput` schema 接受合法 `messageAttachments` 并拒绝越界/缺字段输入。
- 文件保存后返回值可被映射成本轮附件引用。
- Runtime context 包含非图片附件清单。
- 图片附件被解析为 provider attachment 输入。
- 用户消息版本 metadata 持久化附件引用。

UI 纯展示细节可以通过组件测试覆盖关键状态，不需要全量 lint/typecheck。

## 实施顺序

1. 扩展共享类型与 RPC schema。
2. 让 composer 持有 pending 附件，发送前保存并绑定引用。
3. 调整拖拽主视图行为，使其进入 pending 附件。
4. 在用户消息 metadata 中持久化 `messageAttachments`。
5. 在 runtime/context 中加入附件清单。
6. 将图片附件转换为 provider attachment 输入。
7. 在消息列表展示附件摘要并支持打开文件预览。

## 风险

- 现有文件保存接口返回绝对路径，直接暴露给 runtime 会扩大边界；实现时需要转换为线程内安全路径。
- Plan mode approval / continuation 会重写 send input，附件字段必须在普通发送中保留，但不应污染计划审批语义。
- 仅附件消息需要明确默认文本，否则空消息会被现有 composer 拦截。
- 图片多模态路径虽然已有 adapter 基础，但 runtime-core 当前 SDK 查询路径可能仍只传文本，需要实现时实测。
- 拖拽从“立即保存”改为“pending 待发送”会改变现有主视图语义，需要确保文件侧栏仍保留资源管理入口。
