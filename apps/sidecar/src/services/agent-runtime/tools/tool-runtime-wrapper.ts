import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
import { createDiagnosticLogSummary, createLogger } from "../../infra/logger";
import type { FileAccessLedger } from "./file-access-ledger";
import type { LumeToolDescriptor } from "./tool-types";
import { acquireWorkspaceWriterLease } from "./workspace-writer-lease";

export interface ToolRuntimeWrapInput {
  descriptor: LumeToolDescriptor;
  threadId: string;
  cwd: string;
  fileLedger: FileAccessLedger;
}

export function wrapToolDefinitionWithRuntimePolicies(input: ToolRuntimeWrapInput): ToolDefinition {
  const { descriptor } = input;
  const tool = descriptor.definition;
  let calls = 0;
  const log = createLogger("tool-runtime", input.threadId);

  return {
    ...tool,
    runtimeMetadata: {
      ...(tool as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata,
      source: descriptor.source,
      category: descriptor.metadata.category,
      capability: descriptor.metadata.capability,
      riskLevel: descriptor.metadata.riskLevel,
      sideEffects: descriptor.metadata.sideEffects,
      allowedInPlanMode: descriptor.metadata.allowedInPlanMode,
      isReadOnly: descriptor.metadata.isReadOnly,
      isConcurrencySafe: descriptor.metadata.isConcurrencySafe,
      requiresApprovalByDefault: descriptor.metadata.requiresApprovalByDefault,
      ...(descriptor.metadata.payloadPolicy ? { payloadPolicy: descriptor.metadata.payloadPolicy } : {}),
      ...(descriptor.metadata.resultPolicy ? { resultPolicy: descriptor.metadata.resultPolicy } : {}),
      ...(descriptor.metadata.executionPolicy ? { executionPolicy: descriptor.metadata.executionPolicy } : {}),
      runtimeWrapped: true
    },
    async call(rawInput, context) {
      const startedAt = Date.now();
      const computerUseTool = descriptor.name.startsWith("mcp__computer_use__");
      const inputSummary = computerUseTool
        ? summarizeToolInput(rawInput, true)
        : createDiagnosticLogSummary(rawInput);
      log.info("tool call started", {
        threadId: input.threadId,
        toolName: tool.name,
        canonicalName: descriptor.canonicalName,
        source: descriptor.source,
        capability: descriptor.metadata.capability,
        riskLevel: descriptor.metadata.riskLevel,
        toolUseId: context.toolUseId,
        inputSummary
      });
      const payloadGuard = enforcePayloadPolicy(descriptor, rawInput, context.toolUseId);
      if (payloadGuard) {
        log.warn("tool call blocked by payload policy", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          elapsedMs: Date.now() - startedAt
        });
        return payloadGuard;
      }

      calls++;
      const maxCalls = descriptor.metadata.executionPolicy?.maxCallsPerTurn;
      if (maxCalls !== undefined && calls > maxCalls) {
        log.warn("tool call blocked by max call policy", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          calls,
          maxCalls,
          elapsedMs: Date.now() - startedAt
        });
        return errorResult(context.toolUseId, `${tool.name} 超过本轮最大调用次数 ${maxCalls}`);
      }

      const executionGuard = enforceExecutionPolicy(descriptor, rawInput, context.toolUseId);
      if (executionGuard) {
        log.warn("tool call blocked by execution policy", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          elapsedMs: Date.now() - startedAt
        });
        return executionGuard;
      }

      const lease = isMutationTool(descriptor.canonicalName)
        ? await acquireWorkspaceWriterLease(input.cwd, `${input.threadId}:${context.toolUseId ?? "unknown"}`)
        : undefined;
      const leaseHeartbeat = lease ? setInterval(() => lease.heartbeat(), 15_000) : undefined;
      leaseHeartbeat?.unref?.();
      const releaseLease = () => {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        lease?.();
      };
      const fileGuard = await enforceFileAccessPolicy(input, rawInput, context.toolUseId);
      if (fileGuard) {
        releaseLease();
        log.warn("tool call blocked by file access policy", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          elapsedMs: Date.now() - startedAt
        });
        return fileGuard;
      }

      context.emitEvent?.({
        type: "system",
        subtype: "tool_started",
        canonical_name: descriptor.canonicalName,
        source: descriptor.source,
        risk_level: descriptor.metadata.riskLevel,
        tool_name: tool.name,
        tool_use_id: context.toolUseId ?? "",
        input_summary: computerUseTool ? inputSummary : summarizeToolInput(rawInput),
        session_id: context.sessionId ?? input.threadId
      } as any);

      let result: ToolResult = errorResult(context.toolUseId, `${tool.name} 未返回结果`);
      const backgroundLease = lease && descriptor.canonicalName === "bash"
        ? releaseLease
        : undefined;
      try {
        result = await tool.call(
          rawInput,
          backgroundLease
            ? { ...context, onBackgroundTaskCompleted: backgroundLease }
            : context
        );
      } catch (error) {
        log.error("tool call threw", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          error,
          elapsedMs: Date.now() - startedAt
        });
        result = errorResult(context.toolUseId, `${tool.name} 执行失败：${normalizeErrorMessage(error)}`);
      } finally {
        const keepsLeaseUntilBackgroundCompletion = backgroundLease
          && getExecutionTerminationReason(result) === "running";
        if (!keepsLeaseUntilBackgroundCompletion) releaseLease();
      }

      await recordFileRead(input, rawInput, result);
      const governed = normalizeToolResultWithPolicies(result, descriptor.metadata.resultPolicy?.maxChars);

      context.emitEvent?.({
        type: "system",
        subtype: "tool_completed",
        canonical_name: descriptor.canonicalName,
        source: descriptor.source,
        risk_level: descriptor.metadata.riskLevel,
        tool_name: tool.name,
        tool_use_id: context.toolUseId ?? "",
        is_error: governed.result.is_error === true,
        output_summary: governed.summary,
        original_size: governed.originalSize,
        truncated: governed.truncated,
        ...(governed.result.is_error === true ? { error_code: "tool_error" } : {}),
        session_id: context.sessionId ?? input.threadId
      } as any);

      log[governed.result.is_error === true ? "warn" : "info"]("tool call completed", {
        threadId: input.threadId,
        toolName: tool.name,
        canonicalName: descriptor.canonicalName,
        source: descriptor.source,
        capability: descriptor.metadata.capability,
        riskLevel: descriptor.metadata.riskLevel,
        toolUseId: context.toolUseId,
        isError: governed.result.is_error === true,
        outputSummary: governed.summary,
        originalSize: governed.originalSize,
        truncated: governed.truncated,
        elapsedMs: Date.now() - startedAt
      });

      return governed.result;
    }
  };
}

function enforceExecutionPolicy(
  descriptor: LumeToolDescriptor,
  rawInput: unknown,
  toolUseId: string | undefined
): ToolResult | null {
  if (descriptor.metadata.executionPolicy?.allowBackground !== false) return null;
  if (!requestsBackgroundExecution(rawInput)) return null;
  return errorResult(toolUseId, `${descriptor.name} 不允许后台执行`);
}

function requestsBackgroundExecution(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return record.run_in_background === true || record.isolation === "remote";
}

function summarizeToolInput(input: unknown, computerUse = false): string {
  const redacted = computerUse
    ? redactComputerUseInput(input)
    : redactSensitiveValues(input);
  const text = stringifyInput(redacted);
  const maxChars = 500;
  return text.length > maxChars ? `${text.slice(0, maxChars)}...(truncated)` : text;
}

function redactComputerUseInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return redactSensitiveValues(input);
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if ((key === "text" || key === "value") && typeof value === "string") {
      redacted[`${key}Length`] = value.length;
      continue;
    }
    redacted[key] = redactSensitiveValues(value);
  }
  return redacted;
}

function redactSensitiveValues(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveValues(item));
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactSensitiveValues(value);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("api_key")
    || normalized.includes("apikey");
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input);
  }
}

function enforcePayloadPolicy(
  descriptor: LumeToolDescriptor,
  rawInput: unknown,
  toolUseId: string | undefined
): ToolResult | null {
  const maxChars = descriptor.metadata.payloadPolicy?.maxInputChars;
  if (!maxChars) return null;
  if (measureInputChars(rawInput) <= maxChars) return null;
  return errorResult(toolUseId, `${descriptor.name} 输入超过最大长度 ${maxChars} 字符`);
}

function measureInputChars(input: unknown): number {
  if (typeof input === "string") return input.length;
  try {
    return JSON.stringify(input ?? {}).length;
  } catch {
    return String(input).length;
  }
}

async function enforceFileAccessPolicy(
  input: ToolRuntimeWrapInput,
  rawInput: unknown,
  toolUseId: string | undefined
): Promise<ToolResult | null> {
  const filePath = readInputPath(rawInput);
  if (!filePath) return null;
  const canonical = resolve(input.cwd, filePath);
  if (!(await exists(canonical))) return null;

  const name = input.descriptor.canonicalName;
  if (name !== "write" && name !== "edit" && name !== "notebookedit") return null;

  const check = await input.fileLedger.assertCanOverwrite({
    threadId: input.threadId,
    cwd: input.cwd,
    filePath: canonical
  });
  if (check.ok) return null;
  return errorResult(toolUseId, check.message);
}

async function recordFileRead(
  input: ToolRuntimeWrapInput,
  rawInput: unknown,
  result: ToolResult
): Promise<void> {
  if (input.descriptor.canonicalName !== "read" || result.is_error) return;
  const filePath = readInputPath(rawInput);
  if (!filePath) return;
  const canonical = resolve(input.cwd, filePath);
  if (!(await exists(canonical))) return;
  const fileStat = await stat(canonical);
  const contentHash = createHash("sha256").update(await readFile(canonical)).digest("hex");
  const fullRead = isFullReadResult(result);
  input.fileLedger.recordRead({
    threadId: input.threadId,
    cwd: input.cwd,
    filePath: canonical,
    mtimeMs: fileStat.mtimeMs,
    contentHash,
    fullRead,
    readRange: getReadRange(result)
  });
}

function getExecutionTerminationReason(result: ToolResult | undefined): string | undefined {
  const execution = result?._meta?.execution;
  return execution && typeof execution === "object"
    ? (execution as { terminationReason?: unknown }).terminationReason as string | undefined
    : undefined;
}

function isMutationTool(canonicalName: string): boolean {
  return canonicalName === "write"
    || canonicalName === "edit"
    || canonicalName === "notebookedit"
    || canonicalName === "bash"
    || canonicalName === "lsp";
}

function readInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.notebook_path ?? record.path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isFullReadResult(result: ToolResult): boolean {
  const data = parseObjectContent(result.content);
  if (data.summarized === true) return false;
  if (typeof data.remainingLines === "number") {
    return (data.offset === undefined || data.offset === 0) && data.remainingLines <= 0;
  }
  return true;
}

function getReadRange(result: ToolResult): { offset: number; limit: number; totalLines?: number } | undefined {
  const data = parseObjectContent(result.content);
  if (typeof data.offset !== "number" || typeof data.limit !== "number") return undefined;
  return {
    offset: data.offset,
    limit: data.limit,
    ...(typeof data.totalLines === "number" ? { totalLines: data.totalLines } : {})
  };
}

function parseObjectContent(content: ToolResult["content"]): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface GovernedToolResult {
  result: ToolResult;
  originalSize: number;
  truncated: boolean;
  summary: string;
}

export function normalizeToolResultWithPolicies(result: ToolResult, maxChars: number | undefined): GovernedToolResult {
  const originalText = stringifyResultPayload(readResultPayload(result));
  const originalSize = originalText.length;
  if (!maxChars || originalSize <= maxChars) {
    return {
      result,
      originalSize,
      truncated: false,
      summary: summarizeToolOutput(originalText)
    };
  }
  const truncatedText = truncateMiddle(originalText, maxChars);
  const governed = writeResultPayload(result, truncatedText);
  return {
    result: governed,
    originalSize,
    truncated: true,
    summary: summarizeToolOutput(truncatedText)
  };
}

function readResultPayload(result: ToolResult): unknown {
  const record = result as unknown as Record<string, unknown>;
  if ("content" in record) return record.content;
  if ("data" in record) return record.data;
  return result;
}

function writeResultPayload(result: ToolResult, payload: string): ToolResult {
  const record = result as unknown as Record<string, unknown>;
  if ("content" in record) {
    return { ...result, content: payload };
  }
  if ("data" in record) {
    return { ...(result as unknown as Record<string, unknown>), data: payload } as unknown as ToolResult;
  }
  return { ...result, content: payload };
}

function stringifyResultPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload ?? "");
  } catch {
    return String(payload);
  }
}

function summarizeToolOutput(output: string): string {
  const maxChars = 500;
  return output.length > maxChars ? `${output.slice(0, maxChars)}...(truncated)` : output;
}

function truncateMiddle(content: string, maxChars: number): string {
  const marker = "\n...(truncated)...\n";
  if (maxChars <= marker.length) {
    return content.slice(0, maxChars);
  }
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = remaining - head;
  const tailContent = tail > 0 ? content.slice(-tail) : "";
  return `${content.slice(0, head)}${marker}${tailContent}`;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "unknown error";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorResult(toolUseId: string | undefined, content: string): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUseId ?? "",
    content,
    is_error: true
  };
}
