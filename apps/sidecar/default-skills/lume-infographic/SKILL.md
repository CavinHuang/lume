---
name: "lume-infographic"
description: "为 Lume 最终回复生成安全的 AntV Infographic DSL。仅在多维对比、阶段、时间线、层级、关系、指标或分类等高信息密度结构确实能通过视觉布局提升理解时使用；不按内容长度触发"
metadata:
  when_to_use: "当主对话或自动化任务的最终内容包含多个需要同时理解的实体、阶段、指标或关系，并且信息图比普通文字、列表或表格更清晰时使用"
  version: "1.0"
---

# Lume Infographic

只生成 Lume 内置渲染器支持的安全 DSL。信息图用于补充正文，不替代必要解释；每次回复最多输出一张。

## 先判断是否值得画

同时确认：

1. 存在多个需要同时理解的实体、阶段、指标或关系。
2. 视觉布局能比普通列表、表格或文字明显降低理解成本。
3. 有语义匹配的模板，而不是为了装饰强行套用。

任一项不成立就保持纯文本。短而密集的内容可以画；很长但主要是叙述、代码或单一结论的内容不要画。

## 选择模板

- 横向要点：`list-row-horizontal-icon-arrow`
- 卡片概览：`list-grid-badge-card`
- 递进步骤：`sequence-ascending-steps`
- 时间线：`sequence-timeline-simple`
- 交互过程：`sequence-interaction-default-badge-card`
- 二元利弊：`compare-binary-horizontal-simple-fold`
- SWOT：`compare-swot`
- 四象限：`compare-quadrant-quarter-simple-card`
- 层级树：`hierarchy-tree-curved-line-rounded-rect-node`
- 思维导图：`hierarchy-mindmap-level-gradient-compact-card`
- 有向关系：`relation-dagre-flow-tb-badge-card`
- 折线指标：`chart-line-plain-text`
- 横向柱状：`chart-bar-plain-text`
- 纵向柱状：`chart-column-simple`
- 环形占比：`chart-pie-donut-plain-text`
- 词频概览：`chart-wordcloud`

## 输出安全 DSL

- 输出一个 `infographic` fenced code block，放在必要正文之后。
- 这是 AntV 缩进 DSL，不是 YAML：字段写成 `label 内容`，禁止写成 `label: 内容`；每深入一层固定增加两个空格，`-` 必须缩进在对应的 `items`、`children` 等列表键之下。
- 顶层只使用 `infographic`、`data`、`theme`；不要写 `design`、`width` 或 `height`。
- 数据只使用 `title`、`desc`、`items`、`lists`、`sequences`、`root`、`compares`、`nodes`、`relations`、`values`、`order`。
- 数据项只使用 `id`、`label`、`desc`、`value`、`group`、`category`、`children`、`icon`。
- `icon` 可省略；需要时只写不超过三个单词的通用小写英文关键词，如 `growth`、`team work`、`security shield`。不要从用户正文复制专有名词作为图标词。
- 主题只使用 `light`、`dark` 或 `hand-drawn`，以及可选的十六进制 `colorPrimary`、`colorBg`、`palette`。
- 禁止 HTML、外链脚本、URL、`data:`、`ref:`、内联或远程 SVG、资源对象、`illus`、`attributes`、自定义字体和文件写入。

列表、步骤、对比和图表使用对应数据键；层级使用 `root` 和 `children`；关系图使用 `nodes` 与 `relations`：

```infographic
infographic sequence-timeline-simple
data
  title 产品交付阶段
  sequences
    - label 发现
      desc 明确问题与成功标准
      icon search
    - label 构建
      desc 完成最小可验证实现
      icon tools
    - label 发布
      desc 验证结果并逐步放量
      icon rocket
theme light
```

层级结构必须保持 `children` 的嵌套缩进：

```infographic
infographic hierarchy-mindmap-level-gradient-compact-card
data
  root
    id root
    label 产品能力
    children
      - id build
        label 构建
        children
          - id test
            label 验证
theme light
```

输出前检查：确实改善理解、模板匹配、正文仍完整、只有一张图、没有任何自定义或远程资源。
