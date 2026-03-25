interface MemoryToolTextContent {
  type: "text";
  text: string;
}

interface MemoryToolResultEnvelope {
  content: MemoryToolTextContent[];
}

function asText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function createMemoryToolResult(payload: unknown): MemoryToolResultEnvelope {
  return {
    content: [{ type: "text", text: asText(payload) }]
  };
}

export function createMemoryToolErrorResult(payload: unknown): MemoryToolResultEnvelope {
  // OpenClaw 对齐：memory 工具失败使用 disabled payload 返回，不抛 tool error。
  return createMemoryToolResult(payload);
}

