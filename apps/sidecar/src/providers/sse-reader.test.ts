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
      index?: number;
    };
      if (payload.event === "start") {
        return [{
          type: "tool_call_start",
          toolCallId: payload.id ?? "",
          toolName: payload.name ?? "",
          metadata: typeof payload.index === "number"
            ? { blockIndex: payload.index }
            : undefined
        }];
      }
      if (payload.event === "delta") {
        return [({
          type: "tool_call_delta",
          toolCallId: payload.id ?? "",
          argumentsDelta: payload.args ?? "",
          metadata: typeof payload.index === "number"
            ? { blockIndex: payload.index }
            : undefined
        }) as StreamEvent];
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

  test("匿名 delta 早于 start 到达时应回填到首个 tool_call", async () => {
    const adapter = createMockAdapter();
    const body = [
      "data: {\"event\":\"delta\",\"args\":\"{\\\"query\\\":\\\"anonymous\\\"}\"}",
      "data: {\"event\":\"start\",\"id\":\"tc_anon\",\"name\":\"web_search\"}",
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
    expect(result.toolCalls[0]?.id).toBe("tc_anon");
    expect(result.toolCalls[0]?.arguments.query).toBe("anonymous");
  });

  test("带 blockIndex 的交错 delta 应归属到对应 tool_call", async () => {
    const adapter = createMockAdapter();
    const body = [
      "data: {\"event\":\"start\",\"id\":\"toolu_1\",\"name\":\"web_search\",\"index\":0}",
      "data: {\"event\":\"start\",\"id\":\"toolu_2\",\"name\":\"web_search\",\"index\":1}",
      "data: {\"event\":\"delta\",\"args\":\"{\\\"query\\\":\\\"first\\\"}\",\"index\":0}",
      "data: {\"event\":\"delta\",\"args\":\"{\\\"query\\\":\\\"second\\\"}\",\"index\":1}",
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
    expect(result.toolCalls[0]?.id).toBe("toolu_1");
    expect(result.toolCalls[1]?.id).toBe("toolu_2");
    expect(result.toolCalls[0]?.arguments.query).toBe("first");
    expect(result.toolCalls[1]?.arguments.query).toBe("second");
  });
});
