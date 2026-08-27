import type { SDKMessage } from "@lume/agent-sdk";
import type { AgentAskUserQuestionRequest, AgentToolPermissionRequest } from "@lume/shared";

/**
 * 后台跑 SDK agent thread 的公共小工具(#531 收敛)：background-extractor /
 * dream-organizer 两处同型拷贝收敛于此。
 */

/** 拼接一次 agent 运行的 assistant 文本块与最终 result 文本。 */
export function extractAssistantText(messages: SDKMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (message.type === "assistant") {
      const content = (record.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) chunks.push(...content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const value = block as { type?: unknown; text?: unknown };
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      }));
    }
    if (message.type === "result" && typeof record.result === "string") chunks.push(record.result);
  }
  return chunks.join("\n").trim();
}

/** 全 noop 的 agent emitter（后台任务不需要 UI 回流）。 */
export function createSilentAgentEmitter() {
  return {
    onComplete: () => undefined,
    onError: () => undefined,
    onTitleUpdated: () => undefined,
    onAskUserQuestion: (_request: AgentAskUserQuestionRequest) => undefined,
    onToolPermissionRequest: (_request: AgentToolPermissionRequest) => undefined
  };
}
