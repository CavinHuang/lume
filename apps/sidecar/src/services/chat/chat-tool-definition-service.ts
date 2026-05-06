
import type { ChatToolMeta } from "@lume/shared";
import type { ToolDefinition } from "../../providers";

export function getDefaultToolDefinitions(enabledMetas: ChatToolMeta[]): ToolDefinition[] {
  return enabledMetas.map((meta) => {
    if (meta.id === "memory_search") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要检索的关键词或问题"
            }
          },
          required: ["query"]
        }
      };
      return definition;
    }

    if (meta.id === "web_search") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要联网搜索的查询词"
            }
          },
          required: ["query"]
        }
      };
      return definition;
    }

    if (meta.id === "suggest_agent_mode") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "推荐切换 Agent 模式的理由"
            },
            suggestedPrompt: {
              type: "string",
              description: "建议用户在 Agent 模式使用的初始提示词"
            }
          },
          required: ["reason", "suggestedPrompt"]
        }
      };
      return definition;
    }

    if (meta.id === "nano_banana") {
      const definition: ToolDefinition = {
        name: meta.id,
        description: meta.description,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "图片生成/编辑描述，英文描述通常效果更好"
            },
            aspectRatio: {
              type: "string",
              description: "图片宽高比",
              enum: ["1:1", "16:9", "4:3", "9:16", "3:4"]
            },
            imageSize: {
              type: "string",
              description: "图片分辨率",
              enum: ["auto", "1K", "2K", "4K"]
            },
            useReferenceImages: {
              type: "boolean",
              description: "是否使用当前或历史图片附件作为参考图"
            }
          },
          required: ["prompt"]
        }
      };
      return definition;
    }

    const props = Object.fromEntries(
      (meta.params ?? []).map((param) => [
        param.name,
        {
          type: param.type,
          description: param.description,
          ...(param.enum && param.enum.length > 0 ? { enum: param.enum } : {})
        }
      ])
    );
    const properties = Object.keys(props).length > 0
      ? props
      : {
          query: {
            type: "string",
            description: "输入查询内容"
          }
        };
    const required = (meta.params ?? [])
      .filter((param) => param.required)
      .map((param) => param.name);

    const definition: ToolDefinition = {
      name: meta.id,
      description: meta.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {})
      }
    };
    return definition;
  });
}
