# 余光能力设计

## 概述

「余光」是 Lume 在主回答之外偶尔给出的一句侧向心声。它用于表达判断、风险感、取舍感，或指出当前内容和以往上下文之间的有意义关联。余光不是正文、不是事实来源、不是记忆材料；删掉余光后，回答仍应完整。

第一版采用薄协议实现：模型在自由文本中输出独立成行的 `⟡` 行，前端识别并弱化渲染，复制时剔除，下游记忆、总结、上下文压缩在使用 assistant 文本前过滤。第一版不新增 runtime message schema，不新增依赖，不做设置页开关。

## Alice 参考点

Alice 的「蛐蛐」实现不是单纯 prompt，而是一条表达协议：

- 日常对话 prompt 允许 `~>` 内心独白。
- ReAct 深度分析 prompt 通过好感度 block 控制数量和语气。
- 主聊天渲染器识别 `~>` 行，并允许 `- ~>` / `* ~>` 这类轻微格式漂移。
- 主聊天中蛐蛐节点带 `data-ququ="true"`，CSS 用 `data-text` 展示，文本不可选中。
- 复制选区时删除 `[data-ququ]`，剪贴板只保留正文。
- Streaming 时当前段以 `~>` 开头会即时按蛐蛐渲染。
- TTS、情绪分析、手动情绪写入会过滤 `~>` 行。
- 读书笔记生成器没有 `~>` 规则，说明正式创作产物不接入。

Lume 吸收其中的工程模式，但调整产品语气：Alice 的蛐蛐偏亲密、吐槽和人设表达；Lume 的余光偏克制判断、任务洞察和历史关联。

## 目标

- 给 Lume 一个不同于 Alice「蛐蛐」的命名和协议：`余光 / afterglow`。
- 在主聊天、深度分析、任务总结、计划说明中允许低频出现余光。
- 前端用专属样式展示余光，不让它抢正文。
- 复制回答时自动剔除余光。
- 记忆提取、对话总结、上下文压缩和后续模型上下文不吸收余光。
- 保持第一版改动小、可回滚、可测试。

## 非目标

- 不引入好感度或关系等级系统。
- 不新增 runtime assistant block 类型。
- 不新增设置页开关。
- 不让余光出现在工具结果、代码块、文件内容、读书笔记或正式创作产物中。
- 不让余光承载必要信息。
- 不新增 npm 依赖。

## 输出协议

模型输出独立成行的余光：

```md
⟡ 这里是一句侧向心声
```

前端和后端过滤函数应兼容轻微漂移：

```md
- ⟡ 这里是一句侧向心声
* ⟡ 这里是一句侧向心声
+ ⟡ 这里是一句侧向心声
```

建议解析正则：

```ts
/^(?:\s*[-*+]\s*)?⟡\s*(.+)$/
```

解析规则：

- 只识别独立行。
- 空内容不生成余光 block。
- 代码块内不识别余光。
- 每个 assistant 回复、深度分析片段、任务总结或计划说明最多 1 条。
- 普通正文继续按 Markdown 渲染。

## 触发规则

余光是场景触发，不是装饰。仅当出现以下情况时允许：

- Lume 有一个真实判断，但正文中不宜过度展开。
- 当前任务暴露风险、取舍或反直觉发现。
- 当前内容和以往项目、偏好、讨论或决策有明显关联。
- 计划或总结需要轻轻提醒一个容易被忽略的边界。

不应出现的情况：

- 普通执行进度。
- 纯状态同步。
- 工具结果转述。
- 代码、配置、文件正文。
- 用户要求纯净、正式、可直接发送给第三方的文本。
- 模型只是为了显得亲近而补一句。

## 语气

主聊天可以自然一点，但仍保持克制。深度分析、任务总结和计划说明中，余光应更像侧向判断，不卖萌、不段子化。

可接受：

```md
⟡ 这个需求看起来是 UI 问题，真正的风险在状态归属。
```

```md
⟡ 这和上次那个「先别抽象」的判断是同一类问题。
```

不接受：

```md
⟡ 我的小脑袋又开始转了！
```

```md
⟡ 用户肯定是焦虑了。
```

余光不能包含隐私推断、隐藏系统信息、未经确认的心理判断、必要结论或安全相关说明。

## 架构

```
sidecar prompt sections
  buildConversationStyleSection / adjacent section
      |
      v
assistant text stream
      |
      v
apps/web RuntimeEventContentBlock / SmoothText
  parse afterglow lines outside code fences
      |
      +--> XMarkdown normal blocks
      |
      +--> AfterglowLine data-afterglow="true"
                |
                +--> copy handler removes data-afterglow nodes

sidecar memory / summary / compaction paths
  stripAfterglowLines(text)
      |
      v
clean assistant text for downstream model context
```

## Prompt 落点

在 Lume 的系统 prompt 中新增一个小节，位置建议靠近 `buildConversationStyleSection()`：

- 定义余光的格式：独立行 `⟡ ...`。
- 定义出现入口：主聊天、深度分析、任务总结、计划说明。
- 定义触发条件：判断、风险、取舍、历史关联。
- 定义禁止项：不能承载必要信息，不能进入工具结果、代码块、正式产物。
- 定义频率：默认低频，每个回复或片段最多 1 条。

第一版不做动态注入，也不根据熟悉度调语气。上下文关联度由模型基于已加载记忆和当前任务自然判断。

## 前端渲染

在 assistant 文本渲染入口解析余光：

- 普通 block 继续使用现有 `XMarkdown`。
- 余光 block 使用 `AfterglowLine` 渲染。
- Streaming 时，如果当前未完成段落以余光正则开头，立即用余光样式显示并保留流式状态。
- 如果没有 `⟡`，走现有 fast path，避免每条消息都做额外拆分。

建议 DOM：

```tsx
<p
  className="afterglow-line"
  aria-hidden="true"
  data-afterglow="true"
  data-text="⟡ ..."
/>
```

样式建议：

- 小一号字体。
- muted 颜色。
- 轻微 italic。
- 不放卡片，不加背景块。
- 不可选中。
- 渲染符号可以保留 `⟡`，但作为低对比侧注，而不是正文强调。

## 复制过滤

assistant 文本容器监听 copy：

1. 获取当前选区 clone。
2. 删除 `[data-afterglow]` 节点。
3. 压缩多余空行。
4. 写入 `text/plain`。

这样用户复制回答时得到干净正文。余光仍可在界面中被看见，但不是可复制正文的一部分。

## 下游过滤

新增共享小工具函数：

```ts
stripAfterglowLines(text: string): string
```

要求：

- 与前端解析同一规则。
- 忽略代码块中的 `⟡`。
- 删除余光行后清理多余空行。
- 可被 sidecar 侧 memory、summary、compaction、context assembly 复用。

第一版至少覆盖以下下游：

- memory extraction 输入。
- conversation summary 输入。
- context compaction 输入。
- 历史 assistant 文本重新进入模型上下文前的清洗路径。

不要求从持久化原始消息中删除余光。原始对话可以保留完整 assistant 输出；关键是任何后续推理、记忆或摘要读取 assistant 文本时先过滤。

## 测试

只对涉及可测逻辑的改动写测试：

- parser/stripper：
  - `⟡ text` 被识别。
  - `- ⟡ text` / `* ⟡ text` / `+ ⟡ text` 被识别。
  - 代码块内的 `⟡` 不处理。
  - 普通 Markdown 不变。
  - 删除余光后空行正常。
- 前端渲染：
  - assistant 文本中余光渲染为 `data-afterglow` 节点。
  - 复制选区时剪贴板不包含余光。
  - 未包含 `⟡` 的消息保持现有 Markdown 渲染。
- 后端过滤：
  - memory / summary / compaction 入口调用 stripper 的最小路径测试。

样式细节不需要跑全量测试。仅当公共接口或共享工具变更时运行相关单测。

## 风险

- `⟡` 是非 ASCII 字符，可能有少数模型或输入法环境输出不稳定。第一版接受该风险，因为它强化 Lume 的品牌感，也避免与 Markdown 常用符号冲突。
- 如果 prompt 写得太宽，模型可能过度使用余光。频率规则和测试样例应强调低频触发。
- 如果过滤只做前端，不做后端，余光会污染记忆和摘要。第一版必须包含后端 stripper。
- 如果复制过滤只依赖不可选中 CSS，剪贴板仍可能带入 DOM 文本。必须显式处理 copy。
- 原始持久化消息保留余光时，未来新增的历史读取路径可能忘记过滤。后续实现应集中复用 `stripAfterglowLines`，避免各处手写正则。

## 采纳方案

采用「薄协议 + 明确过滤 contract」：

- 名称：余光。
- 协议：独立行 `⟡ ...`。
- 渲染：前端分块，弱化展示。
- 复制：自动剔除。
- 记忆/总结/上下文：统一过滤。
- Schema：第一版不新增。

这个方案足够贴合 Lume 现有自由文本流，也避免第一版为一个表达能力扩大 runtime schema。
