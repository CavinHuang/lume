import type { ChatToolTestResult } from "@lume/shared";
import { testNanoBananaConnection } from "./nano-banana-service";
import { executeHttpChatTool } from "./chat-tool-http-executor";
import { testWebSearchConnection } from "./chat-web-search-service";
import {
  assertKnownToolId,
  readChatToolConfig
} from "./chat-tool-config-store";

export async function testChatToolConnection(input: {
  toolId: string;
  toolCredentials: Record<string, string>;
}): Promise<ChatToolTestResult> {
  if (input.toolId === "memory_search") {
    return { success: true, message: "连接成功，本地记忆检索工具可用" };
  }
  if (input.toolId === "suggest_agent_mode") {
    return { success: true, message: "连接成功，Agent 模式推荐工具可用" };
  }
  if (input.toolId === "nano_banana") {
    return testNanoBananaConnection(input.toolCredentials);
  }
  if (input.toolId === "web_search") {
    return testWebSearchConnection(input.toolCredentials);
  }
  return { success: false, message: `工具 ${input.toolId} 不支持测试` };
}

export async function testChatTool(toolId: string): Promise<ChatToolTestResult> {
  const config = assertKnownToolId(toolId, readChatToolConfig());

  if (toolId === "memory_search" || toolId === "suggest_agent_mode" || toolId === "nano_banana" || toolId === "web_search") {
    return testChatToolConnection({
      toolId,
      toolCredentials: config.toolCredentials[toolId] ?? {}
    });
  }

  const customMeta = config.customTools.find((item) => item.id === toolId);
  if (!customMeta) {
    return { success: false, message: `工具 ${toolId} 不支持测试` };
  }

  if (customMeta.executorType !== "http" || !customMeta.httpConfig) {
    return { success: false, message: `工具 ${toolId} 暂不支持测试` };
  }

  try {
    const result = await executeHttpChatTool(customMeta, {
      userMessage: "test connection",
      credentials: config.toolCredentials[toolId] ?? {}
    });
    return {
      success: true,
      message: result.slice(0, 240) || `连接成功，工具 ${toolId} 可用`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `工具 ${toolId} 测试失败: ${message}`
    };
  }
}
