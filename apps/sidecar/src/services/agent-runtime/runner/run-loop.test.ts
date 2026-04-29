import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import {
  consumeRuntimeCoreQueryStream,
  getRuntimeCoreStreamError,
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";

async function* stream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

describe("runtime-core run loop", () => {
  test("forwards stream messages and completes when output is renderable", async () => {
    const emitted: SDKMessage[] = [];
    const assistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as SDKMessage;

    const result = await consumeRuntimeCoreQueryStream({
      query: stream([assistantMessage]),
      emit: {
        onSdkMessage: (message) => emitted.push(message)
      }
    });

    expect(emitted).toEqual([assistantMessage]);
    expect(result).toEqual({ status: "completed" });
  });

  test("returns SDK result errors", async () => {
    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"]
      } as SDKMessage]),
      emit: {
        onSdkMessage: () => {}
      }
    });

    expect(result).toEqual({
      status: "errored",
      errorMessage: "boom"
    });
  });

  test("rejects usage-only streams without renderable output", async () => {
    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "result",
        subtype: "success",
        usage: { input_tokens: 12 }
      } as SDKMessage]),
      emit: {
        onSdkMessage: () => {}
      }
    });

    expect(result).toEqual({
      status: "errored",
      errorMessage: "runtime-core 未检测到可渲染输出。"
    });
  });

  test("extracts assistant error text before SDK error code", () => {
    expect(getRuntimeCoreStreamError({
      type: "assistant",
      error: "max_output_tokens",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "token budget exhausted" }]
      }
    } as SDKMessage)).toBe("token budget exhausted");
  });

  test("normalizes unsupported permission modes to default query mode", () => {
    expect(normalizeRuntimeCoreQueryPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(normalizeRuntimeCoreQueryPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(normalizeRuntimeCoreQueryPermissionMode("plan")).toBe("plan");
    expect(normalizeRuntimeCoreQueryPermissionMode(undefined)).toBe("default");
    expect(normalizeRuntimeCoreQueryPermissionMode("default")).toBe("default");
  });
});
