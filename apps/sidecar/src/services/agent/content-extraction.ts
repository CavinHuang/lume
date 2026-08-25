function extractTextLikeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    value?: unknown;
    content?: unknown;
    thinking?: unknown;
    reasoning?: unknown;
  };

  if (typeof record.text === "string") return record.text;
  if (typeof record.value === "string") return record.value;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return extractRenderableAssistantText(record.content);
  if (record.text && typeof record.text === "object") return extractTextLikeValue(record.text);
  return "";
}

export function extractRenderableAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string };
    const blockType = typeof block.type === "string" ? block.type : "";
    if (
      blockType === "text"
      || blockType === "output_text"
      || blockType === "outputText"
      || !blockType
    ) {
      const text = extractTextLikeValue(item).trim();
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

function extractReasoningLikeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    value?: unknown;
    content?: unknown;
    thinking?: unknown;
    reasoning?: unknown;
  };

  if (typeof record.thinking === "string") return record.thinking;
  if (typeof record.reasoning === "string") return record.reasoning;
  if (typeof record.text === "string") return record.text;
  if (typeof record.value === "string") return record.value;
  if (typeof record.content === "string") return record.content;
  return "";
}

export function extractAssistantReasoningText(content: unknown): string {
  if (typeof content === "string" || !Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string };
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType !== "reasoning" && blockType !== "thinking") {
      continue;
    }
    const text = extractReasoningLikeValue(item).trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}
