import type { ImRunCardBlock, ImRunCardState } from "./feishu-card-state";

/**
 * 飞书流式卡片渲染（纯函数）：ImRunCardState → CardKit 2.0 JSON。
 *
 * 结构：状态头（颜色随终态变化）+ 有序内容块 + 元信息脚注。
 * 思考块折叠；工具调用统一收进一个可折叠面板（>3 个默认收起），
 * 避免单卡元素超限与长输出刷屏。所有长文本截断保护。
 */

/** 单个 markdown 元素的内容上限（飞书单元素约 30KB，留足余量） */
const MAX_TEXT_CHARS = 3500;
const MAX_PREVIEW_CHARS = 160;
const MAX_TOOL_LINES = 20;
/** 工具调用数超过该值时面板默认折叠 */
const TOOLS_COLLAPSE_THRESHOLD = 3;
/** 正文块保留上限：更早的块合并为一行省略提示，防长运行卡片体积超限 */
const MAX_TEXT_BLOCKS = 8;

interface FeishuCardElement {
  tag: string;
  [key: string]: unknown;
}

export interface FeishuRunCardJson {
  schema: "2.0";
  config: {
    streaming_mode: boolean;
    update_multi?: boolean;
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
  };
  header: {
    title: { tag: "plain_text"; content: string };
    subtitle?: { tag: "plain_text"; content: string };
    template: "blue" | "green" | "red" | "grey" | "orange";
  };
  body: {
    direction: "vertical";
    elements: FeishuCardElement[];
  };
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 1;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

const STATUS_HEADER: Record<ImRunCardState["status"], { title: string; template: FeishuRunCardJson["header"]["template"] }> = {
  running: { title: "正在处理", template: "blue" },
  completed: { title: "已完成", template: "green" },
  failed: { title: "运行失败", template: "red" },
  interrupted: { title: "已中断", template: "grey" },
  turn_limited: { title: "达到轮次上限", template: "orange" }
};

function markdown(content: string): FeishuCardElement {
  return { tag: "markdown", content };
}

function collapsiblePanel(options: {
  title: string;
  expanded: boolean;
  children: FeishuCardElement[];
}): FeishuCardElement {
  return {
    tag: "collapsible_panel",
    expanded: options.expanded,
    header: {
      title: { tag: "plain_text", content: options.title }
    },
    children: options.children
  };
}

function renderToolLine(block: Extract<ImRunCardBlock, { kind: "tool" }>): FeishuCardElement {
  const statusText = block.status === "running" ? "执行中" : block.status === "ok" ? "完成" : "失败";
  const detail = block.status === "failed"
    ? (block.error ?? "工具执行失败")
    : block.preview ?? "";
  const detailPart = detail ? `：${truncateMiddle(detail.replace(/\s+/g, " ").trim(), MAX_PREVIEW_CHARS)}` : "";
  return markdown(`\`${block.toolName}\` ${statusText}${detailPart}`);
}

function footerLine(state: ImRunCardState): string | null {
  if (state.status !== "completed" && state.status !== "failed" && state.status !== "interrupted" && state.status !== "turn_limited") {
    return null;
  }
  const durationMs = (state.endedAtMs ?? Date.now()) - state.startedAtMs;
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const durationText = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  const parts = [`耗时 ${durationText}`];
  if (state.error) {
    parts.push(truncateMiddle(state.error.replace(/\s+/g, " ").trim(), MAX_PREVIEW_CHARS));
  }
  return parts.join(" · ");
}

export function renderImRunCard(state: ImRunCardState): FeishuRunCardJson {
  const header = STATUS_HEADER[state.status];
  const elements: FeishuCardElement[] = [];

  const toolBlocks = state.blocks.filter((block): block is Extract<ImRunCardBlock, { kind: "tool" }> => block.kind === "tool");
  const textBlocks = state.blocks.filter((block): block is Extract<ImRunCardBlock, { kind: "text" }> => block.kind === "text");
  // 超出保留数的更早正文合并为一行省略提示（update 全量重发，块数必须封顶）
  const omittedTextCount = Math.max(0, textBlocks.length - MAX_TEXT_BLOCKS);
  let textIndex = -1;
  for (const block of state.blocks) {
    if (block.kind === "text") {
      textIndex += 1;
      if (textIndex < omittedTextCount) {
        continue;
      }
      if (omittedTextCount > 0 && textIndex === omittedTextCount) {
        elements.push(markdown(`（前 ${omittedTextCount} 段回复已省略）`));
      }
      const text = truncateMiddle(block.text.trimEnd(), MAX_TEXT_CHARS);
      if (text) elements.push(markdown(text));
    } else if (block.kind === "thinking") {
      const text = truncateMiddle(block.text.trim(), MAX_TEXT_CHARS);
      if (text) {
        elements.push(collapsiblePanel({
          title: "思考过程",
          expanded: false,
          children: [markdown(text)]
        }));
      }
    } else if (block.kind === "tool" && toolBlocks.length <= TOOLS_COLLAPSE_THRESHOLD) {
      // 工具少时按序内联展示，保持时间线直观
      elements.push(renderToolLine(block));
    }
  }
  if (toolBlocks.length > TOOLS_COLLAPSE_THRESHOLD) {
    elements.push(collapsiblePanel({
      title: `工具调用（${toolBlocks.length}）`,
      expanded: false,
      children: toolBlocks.slice(0, MAX_TOOL_LINES).map(renderToolLine)
    }));
  }
  if (elements.length === 0 && state.status === "running") {
    elements.push(markdown("…"));
  }

  const footer = footerLine(state);
  if (footer) {
    elements.push({ tag: "hr" }, markdown(footer));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: state.status === "running",
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      title: { tag: "plain_text", content: header.title },
      template: header.template
    },
    body: {
      direction: "vertical",
      elements
    }
  };
}
