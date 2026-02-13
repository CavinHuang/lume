import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  findCliBackendConfig,
  toCanonicalBackendId,
  type AgentCliBackendConfig,
  type AgentRuntimeConfig
} from "./agent-runtime-config";

export type AgentCliBackend = "claude_cli" | "codex_cli";

type CliOutputMode = "json" | "jsonl" | "text";

interface CliBackendConfig {
  id: string;
  command: string;
  args: string[];
  resumeArgs?: string[];
  output: CliOutputMode;
  resumeOutput?: CliOutputMode;
  input?: "arg" | "stdin";
  maxPromptArgChars?: number;
  modelArg: string;
  modelAliases?: Record<string, string>;
  sessionArg?: string;
  sessionArgs?: string[];
  sessionMode?: "always" | "existing" | "none";
  sessionIdFields: string[];
  systemPromptArg?: string;
  systemPromptWhen?: "always" | "first" | "never";
  imageArg?: string;
  imageMode?: "repeat" | "list";
  env?: Record<string, string>;
  clearEnv?: string[];
  serialize?: boolean;
}

interface CliUsage {
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CliRunResult {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
}

const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_CODEX_MODEL = "gpt-5-codex";

const DEFAULT_BACKENDS: Record<string, CliBackendConfig> = {
  "claude-cli": {
    id: "claude-cli",
    command: process.env.LUME_CLAUDE_CLI_BIN?.trim() || "claude",
    args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
    resumeArgs: [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--resume",
      "{sessionId}"
    ],
    output: "json",
    input: "arg",
    modelArg: "--model",
    modelAliases: {
      opus: "opus",
      "opus-4.6": "opus",
      "opus-4.5": "opus",
      "claude-opus-4-6": "opus",
      sonnet: "sonnet",
      "sonnet-4.5": "sonnet",
      "claude-sonnet-4-5": "sonnet",
      haiku: "haiku",
      "haiku-3.5": "haiku",
      "claude-haiku-3-5": "haiku"
    },
    sessionArg: "--session-id",
    sessionMode: "always",
    sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
    systemPromptArg: "--append-system-prompt",
    systemPromptWhen: "first",
    clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
    serialize: true
  },
  "codex-cli": {
    id: "codex-cli",
    command: process.env.LUME_CODEX_CLI_BIN?.trim() || "codex",
    args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
    resumeArgs: [
      "exec",
      "resume",
      "{sessionId}",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check"
    ],
    output: "jsonl",
    resumeOutput: "text",
    input: "arg",
    modelArg: "--model",
    sessionMode: "existing",
    sessionIdFields: ["thread_id", "session_id", "sessionId"],
    serialize: true
  }
};

const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();
const SUSPENDED_CLI_PROCESS_THRESHOLD = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function collectText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => collectText(item)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return value.content.map((item) => collectText(item)).join("");
  if (isRecord(value.message)) return collectText(value.message);
  return "";
}

function pickSessionId(payload: Record<string, unknown>, fields: string[]): string | undefined {
  for (const key of fields) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseUsage(value: unknown): CliUsage | undefined {
  if (!isRecord(value)) return undefined;
  const pick = (key: string): number | undefined => {
    const raw = value[key];
    if (typeof raw === "number" && raw > 0) return raw;
    return undefined;
  };
  const usage: CliUsage = {
    input: pick("input_tokens") ?? pick("inputTokens"),
    output: pick("output_tokens") ?? pick("outputTokens"),
    total: pick("total_tokens") ?? pick("total"),
    cacheRead: pick("cache_read_input_tokens") ?? pick("cacheRead"),
    cacheWrite: pick("cache_write_input_tokens") ?? pick("cacheWrite")
  };
  if (!usage.input && !usage.output && !usage.total && !usage.cacheRead && !usage.cacheWrite) {
    return undefined;
  }
  return usage;
}

function parseJsonOutput(raw: string, config: CliBackendConfig): CliRunResult {
  const trimmed = raw.trim();
  if (!trimmed) return { text: "" };
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (!isRecord(payload)) return { text: trimmed };
    const text =
      collectText(payload.message) ||
      collectText(payload.content) ||
      collectText(payload.result) ||
      collectText(payload);
    return {
      text: text.trim(),
      sessionId: pickSessionId(payload, config.sessionIdFields),
      usage: parseUsage(payload.usage)
    };
  } catch {
    return { text: trimmed };
  }
}

function parseJsonlOutput(raw: string, config: CliBackendConfig): CliRunResult {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { text: "" };

  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const texts: string[] = [];

  for (const line of lines) {
    try {
      const payload = JSON.parse(line) as unknown;
      if (!isRecord(payload)) continue;
      sessionId = sessionId ?? pickSessionId(payload, config.sessionIdFields);
      usage = parseUsage(payload.usage) ?? usage;
      const item = isRecord(payload.item) ? payload.item : undefined;
      const text = item ? collectText(item.text) : collectText(payload);
      if (text.trim()) {
        texts.push(text.trim());
      }
    } catch {
      continue;
    }
  }

  return {
    text: texts.join("\n").trim(),
    sessionId,
    usage
  };
}

function parseCliOutput(raw: string, mode: CliOutputMode, config: CliBackendConfig): CliRunResult {
  if (mode === "text") return { text: raw.trim() };
  if (mode === "jsonl") return parseJsonlOutput(raw, config);
  return parseJsonOutput(raw, config);
}

function mergeBackendConfig(base: CliBackendConfig, override?: AgentCliBackendConfig): CliBackendConfig {
  if (!override) return { ...base };
  return {
    ...base,
    ...(override.command ? { command: override.command } : {}),
    ...(override.args ? { args: override.args } : {}),
    ...(override.resumeArgs ? { resumeArgs: override.resumeArgs } : {}),
    ...(override.output ? { output: override.output } : {}),
    ...(override.resumeOutput ? { resumeOutput: override.resumeOutput } : {}),
    ...(override.input ? { input: override.input } : {}),
    ...(typeof override.maxPromptArgChars === "number" ? { maxPromptArgChars: override.maxPromptArgChars } : {}),
    ...(override.modelArg ? { modelArg: override.modelArg } : {}),
    modelAliases: { ...(base.modelAliases ?? {}), ...(override.modelAliases ?? {}) },
    ...(override.sessionArg ? { sessionArg: override.sessionArg } : {}),
    ...(override.sessionArgs ? { sessionArgs: override.sessionArgs } : {}),
    ...(override.sessionMode ? { sessionMode: override.sessionMode } : {}),
    ...(override.sessionIdFields ? { sessionIdFields: override.sessionIdFields } : {}),
    ...(override.systemPromptArg ? { systemPromptArg: override.systemPromptArg } : {}),
    ...(override.systemPromptWhen ? { systemPromptWhen: override.systemPromptWhen } : {}),
    ...(override.imageArg ? { imageArg: override.imageArg } : {}),
    ...(override.imageMode ? { imageMode: override.imageMode } : {}),
    env: { ...(base.env ?? {}), ...(override.env ?? {}) },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    ...(typeof override.serialize === "boolean" ? { serialize: override.serialize } : {})
  };
}

function getBackendConfig(
  backendId: string,
  runtimeConfig?: AgentRuntimeConfig
): CliBackendConfig {
  const normalizedId = backendId.trim().toLowerCase().replaceAll("_", "-");
  const canonical = toCanonicalBackendId(normalizedId);
  const defaultId = canonical ? canonical.replaceAll("_", "-") : normalizedId;
  const defaultConfig = DEFAULT_BACKENDS[defaultId];
  const override = runtimeConfig ? findCliBackendConfig(runtimeConfig, normalizedId) : undefined;

  if (defaultConfig) {
    return mergeBackendConfig(defaultConfig, override);
  }
  if (!override?.command?.trim()) {
    throw new Error(`未找到 CLI backend 配置: ${backendId}`);
  }
  return {
    id: normalizedId,
    command: override.command.trim(),
    args: override.args ?? [],
    resumeArgs: override.resumeArgs,
    output: override.output ?? "text",
    resumeOutput: override.resumeOutput,
    input: override.input,
    maxPromptArgChars: override.maxPromptArgChars,
    modelArg: override.modelArg ?? "--model",
    modelAliases: override.modelAliases,
    sessionArg: override.sessionArg,
    sessionArgs: override.sessionArgs,
    sessionMode: override.sessionMode,
    sessionIdFields: override.sessionIdFields ?? ["session_id", "sessionId"],
    systemPromptArg: override.systemPromptArg,
    systemPromptWhen: override.systemPromptWhen,
    imageArg: override.imageArg,
    imageMode: override.imageMode,
    env: override.env,
    clearEnv: override.clearEnv,
    serialize: override.serialize
  };
}

async function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained.finally(() => {
    if (CLI_RUN_QUEUE.get(key) === tracked) {
      CLI_RUN_QUEUE.delete(key);
    }
  });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenToRegex(token: string): string {
  if (!token.includes("{sessionId}")) return escapeRegExp(token);
  const parts = token.split("{sessionId}").map((part) => escapeRegExp(part));
  return parts.join("\\S+");
}

function buildSessionMatchers(config: CliBackendConfig): RegExp[] {
  const commandToken = path.basename(config.command ?? "").trim();
  if (!commandToken) return [];

  const matchers: RegExp[] = [];
  const addMatcher = (args: string[]) => {
    if (args.length === 0) return;
    const tokens = [commandToken, ...args];
    const pattern = tokens
      .map((token, index) => {
        const tokenPattern = tokenToRegex(token);
        return index === 0 ? `(?:^|\\s)${tokenPattern}` : `\\s+${tokenPattern}`;
      })
      .join("");
    matchers.push(new RegExp(pattern));
  };

  if (config.sessionArg?.trim()) {
    addMatcher([config.sessionArg.trim(), "{sessionId}"]);
  }
  if ((config.resumeArgs ?? []).some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(config.resumeArgs ?? []);
  }
  return matchers;
}

function collectSuspendedMatchedPids(psOutput: string, matchers: RegExp[]): number[] {
  const suspended: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const stat = match[2] ?? "";
    const command = match[3] ?? "";
    if (!Number.isFinite(pid)) continue;
    if (!stat.includes("T")) continue;
    if (!matchers.some((matcher) => matcher.test(command))) continue;
    suspended.push(pid);
  }
  return suspended;
}

function runUtilityCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...rest] = args;
    if (!command) {
      reject(new Error("缺少命令"));
      return;
    }
    const child = spawn(command, rest, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function cleanupResumeProcesses(config: CliBackendConfig, sessionId: string): Promise<void> {
  if (process.platform === "win32") return;
  const resumeArgs = config.resumeArgs ?? [];
  if (resumeArgs.length === 0) return;
  if (!resumeArgs.some((arg) => arg.includes("{sessionId}"))) return;

  const commandToken = path.basename(config.command ?? "").trim();
  if (!commandToken) return;
  const resumeTokens = resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId));
  const pattern = [commandToken, ...resumeTokens]
    .filter(Boolean)
    .map((token) => escapeRegExp(token))
    .join(".*");
  if (!pattern) return;

  try {
    await runUtilityCommand(["pkill", "-f", pattern]);
  } catch {
    // best effort
  }
}

async function cleanupSuspendedCliProcesses(
  config: CliBackendConfig,
  threshold = SUSPENDED_CLI_PROCESS_THRESHOLD
): Promise<void> {
  if (process.platform === "win32") return;
  const matchers = buildSessionMatchers(config);
  if (matchers.length === 0) return;

  try {
    const ps = await runUtilityCommand(["ps", "-ax", "-o", "pid=,stat=,command="]);
    if (ps.code !== 0) return;
    const suspended = collectSuspendedMatchedPids(ps.stdout, matchers);
    if (suspended.length > threshold) {
      await runUtilityCommand(["kill", "-9", ...suspended.map((pid) => String(pid))]);
    }
  } catch {
    // best effort
  }
}

function runCliCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      params.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      params.signal.removeEventListener("abort", onAbort);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore kill failure
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill failure
        }
      }, 1500);
      fail(new Error("命令执行已取消"));
    };
    params.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill failure
      }
      fail(new Error(`命令执行超时 (${params.timeoutMs}ms)`));
    }, params.timeoutMs);

    if (params.input !== undefined) {
      try {
        child.stdin.write(params.input);
      } catch {
        // ignore
      }
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
  });
}

function normalizeCliModel(modelId: string, config: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const direct = config.modelAliases?.[trimmed];
  if (direct) return direct;
  const lower = trimmed.toLowerCase();
  const mapped = config.modelAliases?.[lower];
  return mapped ?? trimmed;
}

function resolveSessionIdToSend(params: { config: CliBackendConfig; sessionId?: string }): { sessionId?: string; isNew: boolean } {
  const mode = params.config.sessionMode ?? "always";
  const existing = params.sessionId?.trim();
  if (mode === "none") return { sessionId: undefined, isNew: !existing };
  if (mode === "existing") return { sessionId: existing, isNew: !existing };
  if (existing) return { sessionId: existing, isNew: false };
  return { sessionId: randomUUID(), isNew: true };
}

function resolveSystemPromptUsage(params: {
  config: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | undefined {
  const prompt = params.systemPrompt?.trim();
  if (!prompt) return undefined;
  if (!params.config.systemPromptArg?.trim()) return undefined;
  const when = params.config.systemPromptWhen ?? "first";
  if (when === "never") return undefined;
  if (when === "first" && !params.isNewSession) return undefined;
  return prompt;
}

function resolvePromptInput(config: CliBackendConfig, prompt: string): { argPrompt?: string; stdin?: string } {
  const inputMode = config.input ?? "arg";
  if (inputMode === "stdin") return { stdin: prompt };
  if (config.maxPromptArgChars && prompt.length > config.maxPromptArgChars) {
    return { stdin: prompt };
  }
  return { argPrompt: prompt };
}

export async function runAgentCliBackend(params: {
  backend: string;
  modelId?: string;
  prompt: string;
  systemPrompt?: string;
  imagePaths?: string[];
  cwd: string;
  signal: AbortSignal;
  sessionId?: string;
  timeoutMs?: number;
  runtimeConfig?: AgentRuntimeConfig;
}): Promise<CliRunResult> {
  const config = getBackendConfig(params.backend, params.runtimeConfig);
  const defaultModel = config.id.includes("claude") ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;
  const rawModelId = (params.modelId?.trim() || "").trim() || defaultModel;
  const modelId = normalizeCliModel(rawModelId, config);
  const { sessionId: sessionIdToSend, isNew } = resolveSessionIdToSend({
    config,
    sessionId: params.sessionId
  });
  const useResume = Boolean(params.sessionId && sessionIdToSend && config.resumeArgs && config.resumeArgs.length > 0);
  const baseArgs = useResume
    ? (config.resumeArgs ?? config.args).map((entry) => entry.replaceAll("{sessionId}", sessionIdToSend ?? ""))
    : [...config.args];
  const args = [...baseArgs];

  if (!useResume && config.modelArg) {
    args.push(config.modelArg, modelId);
  }
  const systemPromptToSend = resolveSystemPromptUsage({
    config,
    isNewSession: isNew,
    systemPrompt: params.systemPrompt
  });
  if (!useResume && systemPromptToSend && config.systemPromptArg) {
    args.push(config.systemPromptArg, systemPromptToSend);
  }
  if (!useResume && sessionIdToSend) {
    if (config.sessionArgs && config.sessionArgs.length > 0) {
      for (const entry of config.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", sessionIdToSend));
      }
    } else if (config.sessionArg) {
      args.push(config.sessionArg, sessionIdToSend);
    }
  }
  const input = resolvePromptInput(config, params.prompt);
  if (!useResume && params.imagePaths && params.imagePaths.length > 0 && config.imageArg) {
    const mode = config.imageMode ?? "repeat";
    if (mode === "list") {
      args.push(config.imageArg, params.imagePaths.join(","));
    } else {
      for (const imagePath of params.imagePaths) {
        args.push(config.imageArg, imagePath);
      }
    }
  }
  if (input.argPrompt !== undefined) {
    args.push(input.argPrompt);
  }

  const queueKey =
    config.serialize === false ? `${config.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` : config.id;
  const env = {
    ...process.env,
    ...(config.env ?? {})
  };
  for (const key of config.clearEnv ?? []) {
    delete env[key];
  }

  const result = await enqueueCliRun(queueKey, () =>
    (async () => {
      await cleanupSuspendedCliProcesses(config);
      if (useResume && params.sessionId) {
        await cleanupResumeProcesses(config, params.sessionId);
      }
      return runCliCommand({
        command: config.command,
        args,
        cwd: params.cwd,
        env,
        signal: params.signal,
        timeoutMs: params.timeoutMs ?? 10 * 60 * 1000,
        input: input.stdin
      });
    })()
  );

  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || `命令退出码 ${result.code}`).trim();
    throw new Error(`CLI 执行失败: ${message.slice(0, 1200)}`);
  }

  const outputMode = useResume ? (config.resumeOutput ?? config.output) : config.output;
  return parseCliOutput(result.stdout, outputMode, config);
}

export const __internal = {
  collectSuspendedMatchedPids,
  buildSessionMatchersForBackend: (
    backend: string,
    runtimeConfig?: AgentRuntimeConfig
  ): RegExp[] => {
    const config = getBackendConfig(backend, runtimeConfig);
    return buildSessionMatchers(config);
  },
  parseOutputForBackend: (
    backend: string,
    raw: string,
    mode?: "default" | "resume",
    runtimeConfig?: AgentRuntimeConfig
  ): CliRunResult => {
    const config = getBackendConfig(backend, runtimeConfig);
    const outputMode = mode === "resume" ? (config.resumeOutput ?? config.output) : config.output;
    return parseCliOutput(raw, outputMode, config);
  }
};
