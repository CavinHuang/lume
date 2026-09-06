import { access, readFile, realpath, stat } from "node:fs/promises";
import { getRuntimeHostPorts } from "../host-ports";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
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

  const declaredRuntimeMetadata = {
    ...((tool as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata ?? {})
  };
  // 审批豁免键不得随定义自声明穿透 wrapper：插件 manifest 的 metadata 字段
  // 是第三方可控输入，整体透传会让一个字段换来免审免拦。合法豁免（如
  // ExecuteTool）不经 wrapper，不受此剥离影响（#711 review 安全轮）
  delete declaredRuntimeMetadata.delegatesPermission;

  return {
    ...tool,
    runtimeMetadata: {
      ...declaredRuntimeMetadata,
      source: descriptor.source,
      // canUseTool 从盖章数据组装 descriptor（单载体），分类器与权限指纹依赖这两字段
      description: descriptor.metadata.description ?? tool.description,
      canonicalName: descriptor.canonicalName,
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
      // 前缀与 create-computer-use-tools 的注入名同源约定；权威化到常量避免
      // 字面量漂移（browser 族同模式见 shared BROWSER_TOOL_NAME_PREFIX）
      const computerUseTool = descriptor.name.startsWith("mcp__computer_use__");
      // 单次摘要两处复用（#539）：diagnostic 版脱敏最全（含 JWT/凭据路径检测），
      // 日志与事件共用，不再各算一遍深克隆+stringify
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
      // #871：守卫与 tool_started 事件宿主位于既有 try/finally 之前，任一抛出
      // （如 ledger 对竞态删除文件的 stat/readFile）都会让 lease 与 heartbeat
      // 双双滞留——heartbeat 持续刷新会击穿 lease 自身 TTL 看门狗，同 workspace
      // 后续写类调用永久挂起。此处兜底释放后原样上抛，不改变异常传播语义。
      try {
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
          input_summary: inputSummary,
          session_id: context.sessionId ?? input.threadId
        } as any);
      } catch (error) {
        releaseLease();
        log.error("tool runtime guard failed before tool.call", {
          threadId: input.threadId,
          toolName: tool.name,
          canonicalName: descriptor.canonicalName,
          toolUseId: context.toolUseId,
          error,
          elapsedMs: Date.now() - startedAt
        });
        throw error;
      }

      let result: ToolResult = errorResult(context.toolUseId, `${tool.name} 未返回结果`);
      const backgroundLease = lease && descriptor.canonicalName === "bash"
        ? releaseLease
        : undefined;
      const toolTimeoutMs = descriptor.metadata.executionPolicy?.toolTimeoutMs;
      try {
        const callPromise = tool.call(
          rawInput,
          backgroundLease
            ? { ...context, onBackgroundTaskCompleted: backgroundLease }
            : context
        );
        result = toolTimeoutMs
          ? await raceWithToolTimeout(callPromise, toolTimeoutMs, tool.name)
          : await callPromise;
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
      // 写类工具成功落盘后以写后 stat+hash 重录 fullRead：否则账本停留在读前
      // 快照，连续第二次编辑必吃 stale 拒绝、被迫每步插一次 Read（#711 follow-up；
      // 与 SDK 层 updateFileState 写后刷新 cache 的既有语义对齐）
      if (isMutationTool(descriptor.canonicalName) && result.is_error !== true) {
        await reRecordWrittenFile(input, rawInput);
      }
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

// 每工具看门狗（#538）：不响应 abortSignal 的挂死工具不再冻结整轮 run——
// 超时后向引擎返回 is_error 结果，底层调用留在后台自然结束（其结果被丢弃）
function raceWithToolTimeout(call: Promise<ToolResult>, timeoutMs: number, toolName: string): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const timer = setTimeout(
      () => resolve(errorResult(undefined, `${toolName} 执行超过 ${timeoutMs}ms 未完成，已跳过等待（调用仍在后台运行）`)),
      timeoutMs
    );
    timer.unref?.();
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve(errorResult(undefined, `${toolName} 执行失败：${normalizeErrorMessage(error)}`));
      }
    );
  });
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
  // isolation 别名检查已删（#575）：Agent schema 不再声明 isolation，
  // "remote" 永远到不了这里，原检查是恒假的死分支。
  return record.run_in_background === true;
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
  const dream = getRuntimeHostPorts().getThreadMeta(input.threadId)?.memoryProfile?.kind === "dream";
  const name = input.descriptor.canonicalName;
  const filePath = readInputPath(rawInput);
  if (dream && (name === "grep" || name === "find" || name === "glob") && !filePath) {
    return errorResult(toolUseId, "Dream 搜索必须指定当前工作区内的明确路径。");
  }
  if (!filePath) return null;
  const canonical = resolve(input.cwd, filePath);
  if (dream) {
    const workspaceRoot = await realpath(resolve(input.cwd)).catch(() => resolve(input.cwd));
    const actual = await realpath(canonical).catch(() => canonical);
    const rel = relative(workspaceRoot, actual);
    const broadSearch = (name === "grep" || name === "find" || name === "glob") && filePath === ".";
    if (rel.startsWith("..") || isSensitiveDreamPath(actual) || broadSearch) {
      return errorResult(toolUseId, "Dream 只允许读取工作区内的非敏感文件；请缩小到明确的项目路径。");
    }
  }
  if (!(await exists(canonical))) return null;

  if (name !== "write" && name !== "edit" && name !== "multiedit" && name !== "notebookedit") return null;

  const check = await input.fileLedger.assertCanOverwrite({
    threadId: input.threadId,
    cwd: input.cwd,
    filePath: canonical
  });
  if (check.ok) return null;
  return errorResult(toolUseId, check.message);
}

function isSensitiveDreamPath(path: string): boolean {
  return /(^|[\\/])(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$)|\.(?:pem|key|p12|pfx)$/i.test(path);
}

async function recordFileRead(
  input: ToolRuntimeWrapInput,
  rawInput: unknown,
  result: ToolResult
): Promise<void> {
  if (input.descriptor.canonicalName !== "read" || result.is_error) return;
  // unchanged 短路结果不重录：重录会把此前记录的部分视图升级成全文读（#314 同族）
  const readMeta = result._meta?.read;
  if (readMeta && typeof readMeta === "object" && (readMeta as Record<string, unknown>).unchanged === true) return;
  const filePath = readInputPath(rawInput);
  if (!filePath) return;
  const canonical = resolve(input.cwd, filePath);
  if (!(await exists(canonical))) return;
  const fileStat = await stat(canonical);
  // #527-8：SDK 内置 Read 已在读盘时顺带产出原始字节摘要并随 _meta.read
  // 传入（与账本 hashFile 同为 raw 口径），在则免二次整文件 readFile。
  // plugin/MCP 结果与流式范围读无此字段，回落重读；_meta 由同进程 SDK 产生。
  const knownSha =
    readMeta && typeof readMeta === "object"
      ? (readMeta as Record<string, unknown>).rawSha256
      : undefined;
  const contentHash =
    typeof knownSha === "string" && knownSha.length > 0
      ? knownSha
      : createHash("sha256").update(await readFile(canonical)).digest("hex");
  const fullRead = isFullReadResult(result);
  input.fileLedger.recordRead({
    threadId: input.threadId,
    cwd: input.cwd,
    filePath: canonical,
    mtimeMs: fileStat.mtimeMs,
    contentHash,
    fullRead,
    ...(getReadRange(rawInput, result) ? { readRange: getReadRange(rawInput, result) } : {})
  });
}

function getExecutionTerminationReason(result: ToolResult | undefined): string | undefined {
  const execution = result?._meta?.execution;
  return execution && typeof execution === "object"
    ? (execution as { terminationReason?: unknown }).terminationReason as string | undefined
    : undefined;
}

// 写后重录：mutation 工具成功落盘的文件即视为已完整读过（内容是本 run 写的），
// 以写后 stat+hash 覆盖账本快照，支撑连续编辑不被 stale 拒绝。采样失败静默跳过
// ——失败时保留读前记录，下次写入走既有 stale 校验兜底。
async function reRecordWrittenFile(
  input: ToolRuntimeWrapInput,
  rawInput: unknown,
): Promise<void> {
  try {
    const filePath = readInputPath(rawInput);
    if (!filePath) return;
    const canonical = resolve(input.cwd, filePath);
    if (!(await exists(canonical))) return;
    const fileStat = await stat(canonical);
    const contentHash = createHash("sha256").update(await readFile(canonical)).digest("hex");
    input.fileLedger.recordRead({
      threadId: input.threadId,
      cwd: input.cwd,
      filePath: canonical,
      mtimeMs: fileStat.mtimeMs,
      contentHash,
      fullRead: true
    });
  } catch {
    // 静默：写后采样的任何异常都不阻塞工具返回
  }
}

function isMutationTool(canonicalName: string): boolean {
  return canonicalName === "write"
    || canonicalName === "edit"
    || canonicalName === "multiedit"
    || canonicalName === "notebookedit"
    || canonicalName === "bash";
}

function readInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.notebook_path ?? record.path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Read 完整读判定走 _meta.read 结构化字段（partial/truncated/summarized，
// #314 与 #535 同源）。默认 true 服务「无 _meta.read 的旧形制/plugin/MCP
// read」——它们无法自证部分视图；若未来再收窄判定，先想清楚这一默认值放宽的是谁。
// 不做 content 文本嗅探：对抗轮实证零行视图/unchanged 短路会被绕过（#711 review）
function isFullReadResult(result: ToolResult): boolean {
  const readMeta = result._meta?.read;
  if (!readMeta || typeof readMeta !== "object") return true;
  const meta = readMeta as Record<string, unknown>;
  // truncated 单独出现（三方只给 truncated:true 不给 partial）同样非全文——
  // 漏判会把截断视图记成完整读解锁覆写
  return meta.partial !== true && meta.summarized !== true && meta.truncated !== true;
}

function getReadRange(
  rawInput: unknown,
  result: ToolResult
): { offset: number; limit?: number; totalLines?: number } | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const record = rawInput as Record<string, unknown>;
  const offset = typeof record.offset === "number" ? record.offset : undefined;
  const limit = typeof record.limit === "number" ? record.limit : undefined;
  if (offset === undefined && limit === undefined) return undefined;
  const meta = result._meta as { read?: { totalLines?: unknown } } | undefined;
  const totalLines = meta?.read?.totalLines;
  return {
    offset: offset ?? 0,
    ...(limit !== undefined ? { limit } : {}),
    ...(typeof totalLines === "number" ? { totalLines } : {})
  };
}

export interface GovernedToolResult {
  result: ToolResult;
  originalSize: number;
  truncated: boolean;
  summary: string;
}

export function normalizeToolResultWithPolicies(result: ToolResult, maxChars: number | undefined): GovernedToolResult {
  const payload = readResultPayload(result);
  const originalText = stringifyResultPayload(payload);
  const originalSize = originalText.length;
  if (!maxChars || originalSize <= maxChars) {
    return {
      result,
      originalSize,
      truncated: false,
      summary: summarizeToolOutput(originalText)
    };
  }
  // 数组 content 中的 image block(base64 截图等)不参与字节计费,也不能被
  // 字符串化截断——整体截断会把图片替换成损坏的半截 base64 文本(#600)。
  // 只对非 image block 计费;它们超限时合并为单个截断 text block,image 原样保留。
  // 仅限 content 形态:data 形态无已知 image 生产者,维持原有整体截断行为。
  if (
    Array.isArray(payload)
    && "content" in (result as unknown as Record<string, unknown>)
    && payload.some(isImageBlock)
  ) {
    const textPayload = payload.filter((block) => !isImageBlock(block));
    const textJson = JSON.stringify(textPayload ?? "");
    if (textJson.length <= maxChars) {
      // 注意:此处 truncated:false 但 originalSize(含 image 字节)可能超过
      // maxChars——truncated 语义已从「结果合规」收窄为「文本部分被截断」,
      // 勿拿 original_size 做上下文预算。
      return {
        result,
        originalSize,
        truncated: false,
        summary: summarizeToolOutput(textJson)
      };
    }
    const truncatedText = truncateMiddle(textJson, maxChars);
    const governedContent = [{ type: "text", text: truncatedText }, ...payload.filter((block) => isImageBlock(block))];
    return {
      result: { ...result, content: governedContent } as ToolResult,
      originalSize,
      truncated: true,
      summary: summarizeToolOutput(truncatedText)
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

function isImageBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
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
