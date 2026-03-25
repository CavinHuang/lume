import { describe, expect, test } from "bun:test";
import {
  buildMemoryMcpServer,
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "./memory-mcp-service";

type FakeTool = {
  name: string;
  handler: (args: unknown) => Promise<unknown>;
};

function createFakeSdk() {
  return {
    createSdkMcpServer(config: unknown) {
      return config;
    }
  };
}

function readPayloadText(result: unknown): string {
  const record = result as { content?: Array<{ type: string; text: string }> };
  return record.content?.[0]?.text ?? "";
}

function getTools(server: unknown): FakeTool[] {
  const record = server as { tools?: FakeTool[] };
  return record.tools ?? [];
}

describe("memory-mcp-service", () => {
  test("memory_search 正常返回并附带 citations", async () => {
    const server = buildMemoryMcpServer(
      "ws",
      createFakeSdk() as never,
      {
        enabledTools: new Set([MEMORY_SEARCH_TOOL_NAME]),
        includeCitations: true,
        citationsMode: "auto",
        deps: {
          searchWorkspaceMemory: () => Promise.resolve([
            {
              id: "c1",
              path: "MEMORY.md",
              startLine: 3,
              endLine: 4,
              snippet: "remember this",
              score: 0.9,
              source: "memory"
            }
          ]),
          getWorkspaceMemoryStatus: () => ({
            backend: "builtin",
            provider: "lite",
            model: "lite-v1",
            files: 1,
            chunks: 1,
            ftsEnabled: true,
            vecEnabled: false
          }),
        }
      }
    ) as unknown;

    const tools = getTools(server);
    const searchTool = tools.find((item) => item.name === MEMORY_SEARCH_TOOL_NAME);
    expect(searchTool).toBeDefined();
    const result = await searchTool!.handler({ query: "remember" });
    const payload = JSON.parse(readPayloadText(result)) as {
      results: Array<{ snippet: string; citation?: string }>;
      citations: string;
    };
    expect(payload.citations).toBe("auto");
    expect(payload.results[0]?.snippet).toContain("Source:");
    expect(payload.results[0]?.citation).toContain("MEMORY.md#L3-L4");
  });

  test("memory_get 参数错误时返回 disabled payload（不抛 tool error）", async () => {
    const server = buildMemoryMcpServer(
      "ws",
      createFakeSdk() as never,
      {
        enabledTools: new Set([MEMORY_GET_TOOL_NAME]),
        includeCitations: false,
        citationsMode: "off"
      }
    ) as unknown;

    const tools = getTools(server);
    const getTool = tools.find((item) => item.name === MEMORY_GET_TOOL_NAME);
    expect(getTool).toBeDefined();
    const result = await getTool!.handler({});
    const payload = JSON.parse(readPayloadText(result)) as { disabled?: boolean; error?: string };
    expect(payload.disabled).toBeTrue();
    expect(typeof payload.error).toBe("string");
    expect((result as Record<string, unknown>).isError).toBeUndefined();
  });

  test("memory_save 运行异常时返回 disabled payload", async () => {
    const server = buildMemoryMcpServer(
      "ws",
      createFakeSdk() as never,
      {
        enabledTools: new Set([MEMORY_SAVE_TOOL_NAME]),
        includeCitations: false,
        citationsMode: "off",
        deps: {
          saveWorkspaceMemory: async () => {
            throw new Error("save failed");
          }
        }
      }
    ) as unknown;

    const tools = getTools(server);
    const saveTool = tools.find((item) => item.name === MEMORY_SAVE_TOOL_NAME);
    expect(saveTool).toBeDefined();
    const result = await saveTool!.handler({ content: "x" });
    const payload = JSON.parse(readPayloadText(result)) as { disabled?: boolean; error?: string };
    expect(payload.disabled).toBeTrue();
    expect(payload.error).toContain("save failed");
  });
});
