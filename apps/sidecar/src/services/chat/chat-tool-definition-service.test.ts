import { describe, expect, test } from "bun:test";
import type { ChatToolMeta } from "@lume/shared";
import { getDefaultToolDefinitions } from "./chat-tool-definition-service";

describe("chat-tool-definition-service", () => {
  test("应为内置工具生成稳定 schema", () => {
    const metas = [
      {
        id: "web_search",
        name: "联网搜索",
        description: "搜索最新信息",
        category: "builtin"
      },
      {
        id: "nano_banana",
        name: "Nano Banana",
        description: "生成图片",
        category: "builtin"
      }
    ] as ChatToolMeta[];

    const definitions = getDefaultToolDefinitions(metas);

    expect(definitions).toHaveLength(2);
    expect(definitions[0]?.name).toBe("web_search");
    expect(definitions[0]?.parameters.required).toEqual(["query"]);
    expect(definitions[1]?.name).toBe("nano_banana");
    expect(definitions[1]?.parameters.required).toEqual(["prompt"]);
    expect(definitions[1]?.parameters.properties).toHaveProperty("useReferenceImages");
  });

  test("应为自定义工具透传 params 配置", () => {
    const metas = [
      {
        id: "jira_search",
        name: "Jira 搜索",
        description: "查询 Jira",
        category: "custom",
        params: [
          {
            name: "query",
            type: "string",
            description: "查询词",
            required: true
          },
          {
            name: "project",
            type: "string",
            description: "项目 key",
            required: false,
            enum: ["LUME", "PROMA"]
          }
        ]
      }
    ] as ChatToolMeta[];

    const [definition] = getDefaultToolDefinitions(metas);

    expect(definition?.name).toBe("jira_search");
    expect(definition?.parameters.required).toEqual(["query"]);
    expect(definition?.parameters.properties.project).toEqual({
      type: "string",
      description: "项目 key",
      enum: ["LUME", "PROMA"]
    });
  });
});
