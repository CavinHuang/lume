import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  probeProcessSandbox,
  resolveShellInvocation,
  spawnWithProcessSandbox,
  type SandboxSettings
} from "@lume/agent-sdk";
import type { WikiCapabilityMatrix, WikiSearchScope } from "@lume/shared";
import { getAgentThreadMeta } from "../agent/agent-thread-manager";
import { getAgentWorkspace } from "../agent/agent-workspace-manager";
import { getWikiRootPath, getWikiRuntimeProbePath } from "../infra/config-paths";
import { markWikiPhaseAUnavailable, markWikiPhaseBAvailable, markWikiRuntimePreparing, WIKI_CAPABILITIES } from "./wiki-capabilities";
import { resolveTrustedWikiRuntimeProfile } from "./runtime-profile";

export interface ResolveWikiRuntimeCapabilityInput {
  threadId: string;
  cwd: string;
  lumeWorkDir: string;
  filesRoot: string;
  plansRoot: string;
  artifactsRoot: string;
  workspaceId?: string;
  threadType?: string;
  chatType?: string;
}

export interface WikiRuntimeCapability {
  sandbox: SandboxSettings;
  phaseBEnabled: boolean;
  scope?: WikiSearchScope;
  explicitWikiProfile: boolean;
  reason: string;
}

interface ShellToolCandidate {
  command: string;
  executable: string;
  readonlyPaths: string[];
  searchPath: string;
}

interface ShellToolGroup {
  command: string;
  candidates: ShellToolCandidate[];
}

interface RuntimeSandboxProbeResult {
  verified: boolean;
  reason: string;
  selected?: ShellToolCandidate[];
}

const probeCache = new Map<string, Promise<RuntimeSandboxProbeResult>>();

export function createWikiProtectedSandbox(): SandboxSettings {
  const wikiRoot = getWikiRootPath();
  return {
    enabled: true,
    filesystem: {
      denyRead: [wikiRoot],
      denyWrite: [wikiRoot]
    }
  };
}

export function prepareWikiRuntimeCapability(): WikiCapabilityMatrix {
  if (WIKI_CAPABILITIES.runtimeStatus === "ready" || WIKI_CAPABILITIES.runtimeStatus === "preparing") {
    return WIKI_CAPABILITIES;
  }
  void getRuntimeSandboxProbe().then((probe) => {
    if (probe.verified) markWikiPhaseBAvailable(probe.reason);
    else markWikiPhaseAUnavailable(probe.reason);
  }).catch((error) => {
    markWikiPhaseAUnavailable(error instanceof Error ? error.message : String(error));
  });
  return WIKI_CAPABILITIES;
}

export async function resolveWikiRuntimeCapability(
  input: ResolveWikiRuntimeCapabilityInput
): Promise<WikiRuntimeCapability> {
  const meta = getAgentThreadMeta(input.threadId);
  const profile = resolveTrustedWikiRuntimeProfile({
    threadMeta: meta,
    workspaceId: input.workspaceId,
    workspaceExists: Boolean(input.workspaceId && getAgentWorkspace(input.workspaceId)),
    threadType: input.threadType,
    chatType: input.chatType
  });
  const scope = profile?.scope;
  const baseSandbox = createWikiProtectedSandbox();
  const sandboxCandidate = Boolean(
    profile
    || (
      input.threadType === "subagent"
      && input.chatType === "direct"
      && !meta?.source
      && input.workspaceId
      && meta?.workspaceId === input.workspaceId
      && getAgentWorkspace(input.workspaceId)
    )
  );
  if (!sandboxCandidate) {
    return {
      sandbox: baseSandbox,
      phaseBEnabled: false,
      explicitWikiProfile: false,
      reason: "当前会话不是受信任的桌面 Wiki scope"
    };
  }

  const wikiRoot = getWikiRootPath();
  const requiredReadwritePaths = uniqueExistingPaths([
    input.cwd,
    input.lumeWorkDir,
    input.filesRoot,
    input.plansRoot,
    input.artifactsRoot
  ]);
  const overlappingRoot = requiredReadwritePaths.find((path) => pathsOverlap(path, wikiRoot));
  if (overlappingRoot) {
    const reason = `允许根与 Wiki 保护根重叠，保持 Phase A: ${overlappingRoot}`;
    markWikiPhaseAUnavailable(reason);
    return {
      sandbox: baseSandbox,
      phaseBEnabled: false,
      ...(scope ? { scope } : {}),
      explicitWikiProfile: profile?.explicit ?? false,
      reason
    };
  }
  const readwritePaths = [
    ...requiredReadwritePaths,
    ...uniqueExistingPaths([tmpdir()]).filter((path) => !pathsOverlap(path, wikiRoot))
  ];
  const probe = await getRuntimeSandboxProbe();
  if (!probe.verified) {
    markWikiPhaseAUnavailable(probe.reason);
    return {
      sandbox: baseSandbox,
      phaseBEnabled: false,
      ...(scope ? { scope } : {}),
      explicitWikiProfile: profile?.explicit ?? false,
      reason: probe.reason
    };
  }
  markWikiPhaseBAvailable(probe.reason);
  return {
    sandbox: createRuntimeSandbox(wikiRoot, readwritePaths, probe.selected ?? []),
    phaseBEnabled: true,
    ...(scope ? { scope } : {}),
    explicitWikiProfile: profile?.explicit ?? false,
    reason: probe.reason
  };
}

function getRuntimeSandboxProbe(): Promise<RuntimeSandboxProbeResult> {
  const probeRoot = getWikiRuntimeProbePath();
  const wikiRoot = getWikiRootPath();
  const readwritePaths = uniqueExistingPaths([probeRoot, tmpdir()]).filter((path) => !pathsOverlap(path, wikiRoot));
  const cacheKey = JSON.stringify([
    process.platform,
    process.arch,
    resolve(probeRoot),
    wikiRoot,
    process.env.PATH ?? process.env.Path ?? "",
    process.env.PATHEXT ?? ""
  ]);
  let pending = probeCache.get(cacheKey);
  if (!pending) {
    markWikiRuntimePreparing();
    pending = verifyRuntimeSandbox({
      probeRoot,
      wikiRoot,
      readwritePaths,
      toolGroups: discoverShellCompatibility()
    });
    probeCache.set(cacheKey, pending);
  }
  return pending;
}

async function verifyRuntimeSandbox(input: {
  probeRoot: string;
  wikiRoot: string;
  readwritePaths: string[];
  toolGroups: ShellToolGroup[];
}): Promise<RuntimeSandboxProbeResult> {
  const processProbe = await probeProcessSandbox({
    probeRoot: input.probeRoot,
    deniedPath: input.wikiRoot,
    readwritePaths: input.readwritePaths
  });
  if (!processProbe.verified) return processProbe;

  const selectedIndexes = input.toolGroups.map(() => 0);
  const maxAttempts = input.toolGroups.reduce((total, group) => total + group.candidates.length, 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selected = input.toolGroups.map((group, index) => group.candidates[selectedIndexes[index]!]!);
    const sandbox = createRuntimeSandbox(input.wikiRoot, input.readwritePaths, selected);
    const command = [
      "echo LUME_SANDBOX_OK",
      ...selected.flatMap((candidate) => [
        `echo LUME_TOOL_${candidate.command}`,
        `${candidate.command} --version`
      ])
    ].join(" && ");
    try {
      const result = await runShellProbe(command, input.probeRoot, sandbox);
      if (result.code === 0 && result.stdout.includes("LUME_SANDBOX_OK")) {
        return {
          verified: true,
          reason: `操作系统沙箱与 shell 兼容性探针通过${processProbe.isolationTier ? `（${processProbe.isolationTier}）` : ""}`,
          selected
        };
      }
      const failedGroupIndex = resolveFailedToolGroup(result, selected, input.toolGroups);
      if (failedGroupIndex >= 0 && selectedIndexes[failedGroupIndex]! + 1 < input.toolGroups[failedGroupIndex]!.candidates.length) {
        selectedIndexes[failedGroupIndex] = selectedIndexes[failedGroupIndex]! + 1;
        continue;
      }
      return {
        verified: false,
        reason: `沙箱 shell 兼容性探针失败（code=${result.code ?? "null"}）${result.stderr ? `: ${result.stderr.slice(0, 300)}` : ""}`
      };
    } catch (error) {
      return { verified: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { verified: false, reason: "没有可用的沙箱工具链组合" };
}

function createRuntimeSandbox(
  wikiRoot: string,
  readwritePaths: string[],
  selected: ShellToolCandidate[]
): SandboxSettings {
  return {
    ...createWikiProtectedSandbox(),
    processIsolation: {
      enabled: true,
      required: true,
      readonlyPaths: uniqueExistingPaths(selected.flatMap((candidate) => candidate.readonlyPaths)),
      readwritePaths,
      deniedPaths: [wikiRoot],
      executableSearchPaths: uniqueExistingPaths(selected.map((candidate) => candidate.searchPath)),
      allowOutbound: true,
      allowLocalNetwork: true
    }
  };
}

function resolveFailedToolGroup(
  result: { stdout: string; stderr: string },
  selected: ShellToolCandidate[],
  groups: ShellToolGroup[]
): number {
  const blockedPath = result.stderr.match(/write-DAC permission on '([^']+)'/i)?.[1];
  if (blockedPath) {
    const blockedIndex = selected.findIndex((candidate) => candidate.readonlyPaths.some((path) => pathsOverlap(path, blockedPath)));
    if (blockedIndex >= 0) return blockedIndex;
  }
  const markers = [...result.stdout.matchAll(/LUME_TOOL_([A-Za-z0-9_-]+)/g)];
  const failedCommand = markers.at(-1)?.[1];
  return failedCommand ? groups.findIndex((group) => group.command === failedCommand) : -1;
}

async function runShellProbe(
  command: string,
  cwd: string,
  sandbox: SandboxSettings
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const shell = resolveShellInvocation(command);
  const child = spawnWithProcessSandbox(shell.command, shell.args, {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  }, sandbox);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim()
  };
}

function discoverShellCompatibility(): ShellToolGroup[] {
  return ["node", "git", "rg", "bun", "python"].flatMap((command) => {
    const candidates = resolveExecutablesOnPath(command).map((executable) => ({
      command,
      executable,
      readonlyPaths: getExecutableReadonlyPaths(executable),
      searchPath: dirname(executable)
    })).sort((left, right) => getCandidatePreference(left) - getCandidatePreference(right));
    return candidates.length > 0 ? [{ command, candidates }] : [];
  });
}

function getCandidatePreference(candidate: ShellToolCandidate): number {
  if (process.platform !== "win32") return 0;
  if (candidate.command === "node" && isVoltaShim(candidate.executable)) return 2;
  return candidate.readonlyPaths.every((path) => isPathWithin(homedir(), path)) ? 0 : 1;
}

function resolveExecutablesOnPath(command: string): string[] {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const candidates: string[] = [];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command.toLowerCase().endsWith(extension.toLowerCase()) ? command : `${command}${extension}`);
      if (existsSync(candidate)) candidates.push(resolve(candidate));
    }
  }
  if (process.platform === "win32" && command === "node") {
    candidates.push(...resolveVoltaNodeImages());
  }
  return [...new Set(candidates)];
}

export function resolveVoltaNodeImages(
  root = process.env.LOCALAPPDATA?.trim()
    ? join(process.env.LOCALAPPDATA.trim(), "Volta", "tools", "image", "node")
    : undefined
): string[] {
  if (!root) return [];
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+){1,3}$/.test(entry.name))
      .map((entry) => ({ version: entry.name, executable: join(root, entry.name, "node.exe") }))
      .filter((item) => existsSync(item.executable))
      .sort((left, right) => compareNumericVersions(right.version, left.version))
      .map((item) => resolve(item.executable));
  } catch {
    return [];
  }
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function getExecutableReadonlyPaths(executable: string): string[] {
  const parent = dirname(executable);
  const name = basename(executable).toLowerCase();
  const roots: string[] = [];
  if (!isImplicitExecutableRoot(parent)) {
    if (name.startsWith("git") && ["cmd", "bin"].includes(basename(parent).toLowerCase())) {
      roots.push(dirname(parent));
    } else if (name.startsWith("bun") && basename(parent).toLowerCase() === "bin") {
      roots.push(dirname(parent));
    } else {
      roots.push(parent);
    }
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const voltaRoot = localAppData ? join(localAppData, "Volta") : undefined;
  if (voltaRoot && executable.toLowerCase().includes("volta") && !isPathWithin(voltaRoot, executable)) {
    roots.push(voltaRoot);
  }
  return uniqueExistingPaths(roots);
}

function isVoltaShim(executable: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = resolve(executable).toLowerCase();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  return normalized.includes("\\volta\\")
    && !(localAppData && isPathWithin(join(localAppData, "Volta", "tools", "image", "node"), executable));
}

function isImplicitExecutableRoot(path: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = resolve(path).toLowerCase();
  return [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value).toLowerCase())
    .some((root) => normalized === root || normalized.startsWith(`${root}\\`));
}

function uniqueExistingPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(existsSync).map((path) => resolve(path)))];
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
