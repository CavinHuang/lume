import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent, StreamRequestInput, TitleRequestInput } from "./types";
import { streamSSE } from "./sse-reader";

function createMockAdapter(): ProviderAdapter {
  return {
    providerType: "openai",
    buildStreamRequest(_input: StreamRequestInput) {
      throw new Error("not implemented");
    },
    parseSSELine(jsonLine: string): StreamEvent[] {
      const payload = JSON.parse(jsonLine) as {
        event: "start" | "delta" | "done";
        id?: string;
        name?: string;
        args?: string;
        stop?: string;
      };
      if (payload.event === "start") {
        return [{
          type: "tool_call_start",
          toolCallId: payload.id ?? "",
          toolName: payload.name ?? ""
        }];
      }
      if (payload.event === "delta") {
        return [{
          type: "tool_call_delta",
          toolCallId: payload.id ?? "",
          argumentsDelta: payload.args ?? ""
        }];
      }
      if (payload.event === "done") {
        return [{
          type: "done",
          stopReason: payload.stop
        }];
      }
      return [];
    },
    buildTitleRequest(_input: TitleRequestInput) {
      throw new Error("not implemented");
    },
    parseTitleResponse(_responseBody: unknown) {
      return null;
    }
  };
}

describe("sse-reader", () => {
  test("同名 tool_call 应生成唯一 ID 并分别保留参数", async () => {
    const adapter = createMockAdapter();
    const body = [
      "data: {\"event\":\"start\",\"id\":\"web_search\",\"name\":\"web_search\"}",
      "data: {\"event\":\"delta\",\"id\":\"web_search\",\"args\":\"{\\\"query\\\":\\\"q1\\\"}\"}",
      "data: {\"event\":\"start\",\"id\":\"web_search\",\"name\":\"web_search\"}",
      "data: {\"event\":\"delta\",\"id\":\"web_search\",\"args\":\"{\\\"query\\\":\\\"q2\\\"}\"}",
      "data: {\"event\":\"done\",\"stop\":\"tool_use\"}",
      "data: [DONE]"
    ].join("\n");

    const result = await streamSSE({
      request: { url: "https://example.test/sse", headers: {}, body: "{}" },
      adapter,
      onEvent: () => {},
      fetchFn: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    });

    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]?.id).toBe("web_search");
    expect(result.toolCalls[1]?.id).toBe("web_search__2");
    expect(result.toolCalls[0]?.arguments.query).toBe("q1");
    expect(result.toolCalls[1]?.arguments.query).toBe("q2");
  });

  test("delta 早于 start 到达时也应保留参数", async () => {
    const adapter = createMockAdapter();
    const body = [
      "data: {\"event\":\"delta\",\"id\":\"tc_0\",\"args\":\"{\\\"query\\\":\\\"late\\\"}\"}",
      "data: {\"event\":\"start\",\"id\":\"tc_0\",\"name\":\"web_search\"}",
      "data: {\"event\":\"done\",\"stop\":\"tool_use\"}",
      "data: [DONE]"
    ].join("\n");

    const result = await streamSSE({
      request: { url: "https://example.test/sse", headers: {}, body: "{}" },
      adapter,
      onEvent: () => {},
      fetchFn: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    });

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]?.id).toBe("tc_0");
    expect(result.toolCalls[0]?.arguments.query).toBe("late");
  });
});
