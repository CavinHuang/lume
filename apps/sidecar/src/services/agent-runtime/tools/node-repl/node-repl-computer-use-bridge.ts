import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
import { randomUUID } from "node:crypto";
import { COMPUTER_USE_TOOL_NAMES } from "../computer-use/create-computer-use-tools";
import { createLogger } from "../../../infra/logger";
import type {
  NodeReplContentBlock,
  NodeReplComputerUseRequest,
  NodeReplComputerUseResult,
  NodeReplExecutionResult,
} from "./node-repl-types";

const METHODS = new Set<string>(COMPUTER_USE_TOOL_NAMES);
type ToolResultContentBlock = Extract<ToolResult["content"], unknown[]>[number];

export function parseComputerUseHostCall(value: unknown): NodeReplComputerUseRequest {
  const request = asRecord(value);
  if (typeof request.method !== "string" || !METHODS.has(request.method)) {
    throw new Error("unsupported Computer Use method");
  }
  if (!isRecord(request.params)) {
    throw new Error("Computer Use params must be an object");
  }
  return { method: request.method, params: request.params };
}

export function convertComputerUseToolResult(result: ToolResult): NodeReplComputerUseResult {
  const blocks = typeof result.content === "string"
    ? []
    : result.content;
  const publicText = typeof result.content === "string"
    ? result.content
    : blocks.find((block) => block.type === "text")?.text ?? "null";
  const value = parseToolValue(publicText);

  if (result.is_error) {
    const error = isRecord(value) && typeof value.error === "string"
      ? value.error
      : publicText;
    throw new Error(error || "Computer Use request failed");
  }

  const content = blocks
    .filter((block) => block.type !== "text" || block.text !== publicText)
    .flatMap(toNodeContentBlock);
  return {
    value,
    ...(content.length > 0 ? { content } : {}),
    ...(result._meta ? { meta: result._meta } : {}),
  };
}

export function createComputerUseRequestBridge(input: {
  tools: ToolDefinition[];
  threadId: string;
  cwd: string;
}): (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult> {
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const log = createLogger("computer-use", input.threadId);
  return async (request, signal) => {
    const parsed = parseComputerUseHostCall(request);
    log.info("request", { computerUseSurface: "sky", method: parsed.method });
    const tool = tools.get(`mcp__computer_use__${parsed.method}`);
    if (!tool) throw new Error(`Computer Use method is unavailable: ${parsed.method}`);
    const result = await tool.call(parsed.params, {
      cwd: input.cwd,
      sessionId: input.threadId,
      toolUseId: `node-repl-computer-use:${randomUUID()}`,
      abortSignal: signal,
    });
    const converted = convertComputerUseToolResult(result);
    return {
      ...converted,
      meta: { ...(converted.meta ?? {}), computerUseSurface: "sky" },
    };
  };
}

export function mergeComputerUseExecutionResult(
  execution: NodeReplExecutionResult,
  results: NodeReplComputerUseResult[],
): NodeReplExecutionResult {
  if (results.length === 0) return execution;
  const content = [...execution.content];
  let meta = execution._meta ? { ...execution._meta } : undefined;
  const actionFacts = new Map<string, unknown>();
  collectActionFacts(meta, actionFacts);
  for (const result of results) {
    if (result.content?.length) content.push(...result.content);
    if (result.meta) {
      collectActionFacts(result.meta, actionFacts);
      meta = { ...(meta ?? {}), ...result.meta };
    }
  }
  if (actionFacts.size > 0) {
    meta = { ...(meta ?? {}), computerUseActions: [...actionFacts.values()] };
  }
  return {
    ...execution,
    content,
    ...(meta ? { _meta: meta } : {}),
  };
}

function collectActionFacts(
  meta: Record<string, unknown> | undefined,
  facts: Map<string, unknown>,
): void {
  if (!meta) return;
  for (const fact of [
    meta.computerUseAction,
    ...(Array.isArray(meta.computerUseActions) ? meta.computerUseActions : []),
  ]) {
    if (!isRecord(fact) || typeof fact.actionId !== "string") continue;
    const phase = typeof fact.phase === "string" ? fact.phase : "unknown";
    facts.set(`${fact.actionId}:${phase}`, fact);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseToolValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toNodeContentBlock(block: ToolResultContentBlock): NodeReplContentBlock[] {
  if (block.type === "text") {
    const meta = (block as { _meta?: Record<string, unknown> })._meta;
    return [{
      type: "text",
      text: block.text,
      ...(meta ? { _meta: meta } : {}),
    }];
  }
  const source = isRecord(block.source) ? block.source : null;
  if (
    source?.type === "file"
    && typeof source.path === "string"
    && typeof source.media_type === "string"
  ) {
    return [{
      type: "image",
      source: {
        type: "file",
        path: source.path,
        media_type: source.media_type,
      },
      ...(block._meta ? { _meta: block._meta } : {}),
    }];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
