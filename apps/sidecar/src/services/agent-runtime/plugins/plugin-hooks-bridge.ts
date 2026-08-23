import type {
  HookConfig,
  HookDefinition,
  HookInput,
  HookOutput,
  SensitiveCapabilityKey,
  SandboxSettings,
} from "@lume/agent-sdk";
import { resolveShellInvocation, spawnWithProcessSandbox } from "@lume/agent-sdk";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import { createLogger } from "../../infra/logger";

const log = createLogger("plugin-hooks");

/** A capability's resolved hooks paired with its source pluginId. */
export interface PluginHookCapability {
  pluginId: string;
  hooks: HookConfig;
}

/** Shape required by AgentOptions.hooks entries. */
type AgentHookEntry = {
  matcher?: string;
  hooks: Array<(input: HookInput, toolUseId: string, context: { signal: AbortSignal }) => Promise<unknown>>;
  timeout?: number;
};

/** Spawns a shell-command hook. Replicates SDK executeShellHook (which is private). */
export type ShellHookSpawner = (
  command: string,
  input: HookInput,
  timeout: number,
  signal: AbortSignal,
) => Promise<HookOutput | undefined>;

/**
 * Default shell-hook spawner: spawn `bash -c <command>`, JSON on stdin, HOOK_* env vars,
 * parse stdout as HookOutput (non-JSON → {message}). Mirrors packages/sdk/src/hooks.ts:307-377.
 */
export const defaultShellHookSpawner: ShellHookSpawner = (command, input, timeout, signal) => {
  return spawnShellHook(command, input, timeout, signal);
};

function spawnShellHook(
  command: string,
  input: HookInput,
  timeout: number,
  signal: AbortSignal,
  sandbox?: SandboxSettings,
): Promise<HookOutput | undefined> {
  return new Promise((resolve) => {
    const shell = resolveShellInvocation(command);
    const proc = spawnWithProcessSandbox(shell.command, shell.args, {
      cwd: input.cwd || process.cwd(),
      timeoutMs: timeout,
      env: {
        ...process.env,
        HOOK_EVENT: input.event,
        HOOK_TOOL_NAME: input.toolName || "",
        HOOK_SESSION_ID: input.sessionId || "",
        HOOK_CWD: input.cwd || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }, sandbox);

    proc.stdin?.write(JSON.stringify(input));
    proc.stdin?.end();

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    const onAbort = () => proc.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    proc.on("close", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      const renderedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (stdout) {
        try {
          resolve(JSON.parse(stdout) as HookOutput);
          return;
        } catch {
          if (stdout.startsWith("'") && stdout.endsWith("'")) {
            try {
              resolve(JSON.parse(stdout.slice(1, -1)) as HookOutput);
              return;
            } catch {
              try {
                resolve(JSON.parse(stdout.slice(1, -1).replace(/\\"/g, '"')) as HookOutput);
                return;
              } catch {
                // Fall through to the original non-JSON representation.
              }
            }
          }
          // Non-JSON stdout: render combined output as a plain message (#498).
          resolve({ message: renderedOutput });
          return;
        }
      }
      // Empty stdout: stderr (if any) is the hook's only output; both empty → no output.
      resolve(renderedOutput ? { message: renderedOutput } : undefined);
    });
    proc.on("error", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    });
  });
}

export interface BuildPluginAgentHooksInput {
  capabilities: PluginHookCapability[];
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
  spawner?: ShellHookSpawner;
  sandbox?: SandboxSettings;
}

/**
 * Convert resolved plugin HookConfigs → AgentOptions.hooks shape (design spec §6.4).
 *
 * Shell-command hooks (the §8.1 sensitive case) are wrapped in a gate-aware handler
 * that closes over pluginId + event + matcher, calls checkSensitiveCapability with
 * `hook:${event}:${matcher||'*'}`, and only spawns (via `spawner`, default
 * defaultShellHookSpawner) when allow-ed. ask/deny → no spawn + warn-log (Phase 2
 * ask→block; the hook simply does not fire). handler-type hooks pass through wrapped
 * to the (input, toolUseId, {signal}) signature, ungated (rare; not shell subprocesses).
 *
 * Pure given the runtime + spawner (both injectable for tests).
 */
export function buildPluginAgentHooks(input: BuildPluginAgentHooksInput): Record<string, AgentHookEntry[]> {
  const spawner = input.spawner ?? ((command, hookInput, timeout, signal) =>
    spawnShellHook(command, hookInput, timeout, signal, input.sandbox));
  const result: Record<string, AgentHookEntry[]> = {};

  for (const capability of input.capabilities) {
    for (const [event, definitions] of Object.entries(capability.hooks)) {
      if (!Array.isArray(definitions)) continue;
      for (const def of definitions) {
        const entry = convertHookDefinition({
          def,
          event,
          pluginId: capability.pluginId,
          runtime: input.runtime,
          workspaceSlug: input.workspaceSlug,
          spawner,
        });
        if (!entry) continue;
        (result[event] ??= []).push(entry);
      }
    }
  }

  return result;
}

function convertHookDefinition(args: {
  def: HookDefinition;
  event: string;
  pluginId: string;
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
  spawner: ShellHookSpawner;
}): AgentHookEntry | null {
  const { def, event, pluginId, runtime, workspaceSlug, spawner } = args;

  if (def.handler) {
    // handler-type hook: wrap to the (input, toolUseId, {signal}) signature, ungated.
    const handler = def.handler;
    return {
      ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      hooks: [async (hookInput) => handler(hookInput)],
    };
  }

  if (def.command) {
    const command = def.command;
    const matcher = def.matcher;
    const key = `hook:${event}:${matcher || "*"}` as SensitiveCapabilityKey;
    const timeout = def.timeout ?? 30_000;
    return {
      ...(matcher !== undefined ? { matcher } : {}),
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      hooks: [
        async (hookInput, _toolUseId, ctx) => {
          const decision = await runtime.checkSensitiveCapability({ pluginId, key, workspaceSlug });
          if (decision.decision !== "allow") {
            // §8.1/§8.2: shell command hook gated (ask→block per Phase 2). Do NOT spawn.
            log.warn("blocked sensitive plugin hook", {
              pluginId,
              capability: key,
              decision: decision.decision,
              reason: decision.reason,
            });
            return undefined;
          }
          return spawner(command, hookInput, timeout, ctx.signal);
        },
      ],
    };
  }

  return null;
}
