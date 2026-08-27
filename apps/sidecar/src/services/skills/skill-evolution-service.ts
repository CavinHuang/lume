import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  analyzeSkillImprovement,
  applySkillImprovement,
  listSkillVersions,
  restoreSkillVersion,
  type ApiType,
  type ApplySkillImprovementResult,
  type LLMProvider,
  type SkillImprovementMessage,
  type SkillImprovementUpdate,
  type SkillModelCallInput,
  type SkillVersionInfo
} from "@lume/agent-sdk";
import type { AgentMessage, SkillStorageScope } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../channel/channel-manager";
import { resolveProviderApiType } from "../model-runtime/provider-api-type";
import { getAliceUserSkillsDir, getUserSkillsDir, getWorkspaceSkillsDir } from "../infra/config-paths";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveChatProvider } from "../memory-v2/chat-provider";
import { isMarketManagedWorkspaceSkill } from "./workspace-skill-editor-service";

export interface WorkspaceSkillInput {
  workspaceSlug: string;
  skillSlug: string;
  storageScope?: SkillStorageScope;
  cwd?: string;
}

export interface ApplyWorkspaceSkillImprovementInput extends WorkspaceSkillInput {
  updates: SkillImprovementUpdate[];
  callModel?: (input: SkillModelCallInput) => Promise<string>;
  modelRef?: string;
  resolveBinding?: SkillModelBindingResolver;
  decryptApiKey?: (channelId: string) => string;
  createProvider?: SkillProviderFactory;
  getEffectiveConfig?: (workspaceSlug?: string) => SkillEvolutionEffectiveConfigLike;
}

export interface AnalyzeWorkspaceSkillImprovementInput extends WorkspaceSkillInput {
  getRecentMessages: (threadId: string, limit: number) => AgentMessage[] | Promise<AgentMessage[]>;
  callModel?: (input: SkillModelCallInput) => Promise<string>;
  maxSessions?: number;
  messagesPerSession?: number;
  modelRef?: string;
  resolveBinding?: SkillModelBindingResolver;
  decryptApiKey?: (channelId: string) => string;
  createProvider?: SkillProviderFactory;
  getEffectiveConfig?: (workspaceSlug?: string) => SkillEvolutionEffectiveConfigLike;
}

export interface AnalyzeWorkspaceSkillImprovementResult {
  skillSlug: string;
  usageCount: number;
  analyzedSessionIds: string[];
  updates: SkillImprovementUpdate[];
}

export interface AnalyzeThreadWorkspaceSkillImprovementsInput {
  workspaceSlug: string;
  cwd?: string;
  threadId: string;
  getRecentMessages: (threadId: string, limit: number) => AgentMessage[] | Promise<AgentMessage[]>;
  callModel?: (input: SkillModelCallInput) => Promise<string>;
  messagesPerSession?: number;
  maxSkills?: number;
  modelRef?: string;
  resolveBinding?: SkillModelBindingResolver;
  decryptApiKey?: (channelId: string) => string;
  createProvider?: SkillProviderFactory;
  getEffectiveConfig?: (workspaceSlug?: string) => SkillEvolutionEffectiveConfigLike;
}

export interface AnalyzeThreadWorkspaceSkillImprovementResult extends AnalyzeWorkspaceSkillImprovementResult {
  workspaceSlug: string;
  storageScope: SkillStorageScope;
  cwd?: string;
}

export interface WorkspaceSkillImprovementModelCallAttempt {
  modelRef: string;
  callModel: (input: SkillModelCallInput) => Promise<string>;
}

interface SkillEvolutionEffectiveConfigLike {
  models?: {
    chat?: {
      defaultModelRef?: string;
    };
    agent?: {
      defaultModelRef?: string;
    };
  };
}

interface SkillModelBinding {
  channel: {
    id: string;
    provider: string;
    baseUrl?: string;
  };
  modelId: string;
  family?: "anthropic" | "google" | "openai";
}

type SkillModelBindingResolver = (modelRef: string) => SkillModelBinding | null;

type SkillProviderFactory = (input: {
  apiType: ApiType;
  apiKey: string;
  baseURL?: string;
}) => LLMProvider;

export interface RestoreWorkspaceSkillVersionInput extends WorkspaceSkillInput {
  filename: string;
}

function resolveProjectCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (!trimmed) throw new Error("项目目录不能为空");
  return resolve(trimmed);
}

function resolveAliceProjectSkillsDir(cwd: string | undefined): string {
  return join(resolveProjectCwd(cwd), ".alice", "skills");
}

function resolveLegacyProjectSkillsDir(cwd: string | undefined): string {
  return join(resolveProjectCwd(cwd), ".lume", "skills");
}

function resolveSkillFileFromRoot(rootDir: string, skillSlug: string): string {
  const skillsDir = resolve(rootDir);
  const skillDir = resolve(skillsDir, skillSlug);
  const relativePath = relative(skillsDir, skillDir);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    relativePath.includes(`${sep}..`) ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("非法 Skill 路径");
  }

  return resolve(skillDir, "SKILL.md");
}

export function resolveWorkspaceSkillFile(input: WorkspaceSkillInput): string {
  let skillPath: string;
  if (input.storageScope === "user") {
    const aliceSkillPath = resolveSkillFileFromRoot(getAliceUserSkillsDir(), input.skillSlug);
    if (existsSync(aliceSkillPath)) return aliceSkillPath;
    const legacySkillPath = resolveSkillFileFromRoot(getUserSkillsDir(), input.skillSlug);
    skillPath = existsSync(legacySkillPath) ? legacySkillPath : aliceSkillPath;
  } else if (input.storageScope === "project") {
    const aliceSkillPath = resolveSkillFileFromRoot(resolveAliceProjectSkillsDir(input.cwd), input.skillSlug);
    if (existsSync(aliceSkillPath)) return aliceSkillPath;
    const legacySkillPath = resolveSkillFileFromRoot(resolveLegacyProjectSkillsDir(input.cwd), input.skillSlug);
    skillPath = existsSync(legacySkillPath) ? legacySkillPath : aliceSkillPath;
  } else {
    skillPath = resolveSkillFileFromRoot(getWorkspaceSkillsDir(input.workspaceSlug), input.skillSlug);
  }

  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${input.skillSlug}`);
  }
  return skillPath;
}

function assertSettingsManagedWorkspaceSkill(input: WorkspaceSkillInput): void {
  if (input.storageScope && input.storageScope !== "workspace") return;
  if (!isMarketManagedWorkspaceSkill(input.workspaceSlug, input.skillSlug)) return;
  throw new Error("市场管理的 Skill 请在技能市场中管理");
}

export async function listWorkspaceSkillVersions(
  input: WorkspaceSkillInput
): Promise<SkillVersionInfo[]> {
  assertSettingsManagedWorkspaceSkill(input);
  return listSkillVersions(resolveWorkspaceSkillFile(input));
}

export async function analyzeWorkspaceSkillImprovement(
  input: AnalyzeWorkspaceSkillImprovementInput
): Promise<AnalyzeWorkspaceSkillImprovementResult> {
  assertSettingsManagedWorkspaceSkill(input);
  const skillPath = resolveWorkspaceSkillFile(input);
  const skillContent = await readFile(skillPath, "utf-8");
  const usageRecords = await readSkillUsageRecords(skillPath);
  const sessionIds = pickRecentUsageSessionIds(usageRecords, input.maxSessions ?? 5);
  const messages: SkillImprovementMessage[] = [];

  for (const sessionId of sessionIds) {
    const recentMessages = await input.getRecentMessages(sessionId, input.messagesPerSession ?? 100);
    messages.push(...toSkillImprovementMessages(recentMessages));
  }

  if (messages.length === 0) {
    return {
      skillSlug: input.skillSlug,
      usageCount: usageRecords.length,
      analyzedSessionIds: sessionIds,
      updates: []
    };
  }

  const modelCall = input.callModel ?? createWorkspaceSkillImprovementModelCall(input)?.callModel;
  if (!modelCall) {
    throw new Error("未找到可用的 Skill 改进分析模型，请先配置 Agent 默认模型");
  }

  return {
    skillSlug: input.skillSlug,
    usageCount: usageRecords.length,
    analyzedSessionIds: sessionIds,
    updates: await analyzeSkillImprovement({
      skillContent,
      messages,
      callModel: modelCall
    })
  };
}

export async function analyzeThreadWorkspaceSkillImprovements(
  input: AnalyzeThreadWorkspaceSkillImprovementsInput
): Promise<AnalyzeThreadWorkspaceSkillImprovementResult[]> {
  const usedSkills = await listThreadUsedWorkspaceSkills(input);
  if (usedSkills.length === 0) return [];

  const modelCall = input.callModel ?? createWorkspaceSkillImprovementModelCall(input)?.callModel;
  if (!modelCall) {
    throw new Error("未找到可用的 Skill 改进分析模型，请先配置 Agent 默认模型");
  }

  let threadMessages: SkillImprovementMessage[] | null = null;
  const results: AnalyzeThreadWorkspaceSkillImprovementResult[] = [];

  for (const skill of usedSkills.slice(0, input.maxSkills ?? 5)) {
    threadMessages ??= toSkillImprovementMessages(
      await input.getRecentMessages(input.threadId, input.messagesPerSession ?? 100)
    );
    if (threadMessages.length === 0) break;

    const updates = await analyzeSkillImprovement({
      skillContent: await readFile(skill.skillPath, "utf-8"),
      messages: threadMessages,
      callModel: modelCall
    });
    if (updates.length === 0) continue;

    results.push({
      workspaceSlug: input.workspaceSlug,
      storageScope: skill.storageScope,
      ...(skill.cwd ? { cwd: skill.cwd } : {}),
      skillSlug: skill.skillSlug,
      usageCount: skill.usageCount,
      analyzedSessionIds: [input.threadId],
      updates
    });
  }

  return results;
}

export function createWorkspaceSkillImprovementModelCall(
  input: {
    workspaceSlug?: string;
    modelRef?: string;
    resolveBinding?: SkillModelBindingResolver;
    decryptApiKey?: (channelId: string) => string;
    createProvider?: SkillProviderFactory;
    getEffectiveConfig?: (workspaceSlug?: string) => SkillEvolutionEffectiveConfigLike;
  }
): WorkspaceSkillImprovementModelCallAttempt | undefined {
  const modelRef = resolveSkillImprovementModelRef(input);
  if (!modelRef) return undefined;

  const binding = (input.resolveBinding ?? defaultResolveBinding)(modelRef);
  if (!binding && !input.createProvider) return undefined;

  const provider = input.createProvider
    ? input.createProvider({
      apiType: binding
        ? resolveProviderApiType({ family: binding.family, provider: binding.channel.provider })
        : "openai-completions",
      apiKey: binding ? (input.decryptApiKey ?? decryptApiKey)(binding.channel.id) : "",
      baseURL: binding?.channel.baseUrl
    })
    // 注入的 input.resolveBinding 在此分支不生效：resolveChatProvider 固定走真实渠道解析
    // （生产路径无影响，RPC 层不注入 resolver）
    : resolveChatProvider(modelRef).provider;
  const model = binding?.modelId ?? modelRef.split("/").at(-1) ?? modelRef;

  return {
    modelRef,
    callModel: async (request) => {
      const response = await provider.createMessage({
        model,
        maxTokens: 1200,
        system: request.systemPrompt,
        messages: [{
          role: "user",
          content: request.userPrompt
        }]
      });
      return response.content
        .map((block) => block.type === "text" ? block.text : "")
        .filter(Boolean)
        .join("\n");
    }
  };
}

export async function applyWorkspaceSkillImprovement(
  input: ApplyWorkspaceSkillImprovementInput
): Promise<ApplySkillImprovementResult> {
  if (input.updates.length === 0) {
    return { success: false, error: "没有改进建议" };
  }
  if ((!input.storageScope || input.storageScope === "workspace") && isMarketManagedWorkspaceSkill(input.workspaceSlug, input.skillSlug)) {
    return { success: false, error: "市场管理的 Skill 请在技能市场中管理" };
  }

  const modelCall = input.callModel ?? createWorkspaceSkillImprovementModelCall(input)?.callModel;
  if (!modelCall) {
    return {
      success: false,
      error: "未找到可用的 Skill 改进应用模型，请先配置 Agent 默认模型"
    };
  }

  return applySkillImprovement({
    skillPath: resolveWorkspaceSkillFile(input),
    updates: input.updates,
    callModel: modelCall
  });
}

export async function restoreWorkspaceSkillVersion(
  input: RestoreWorkspaceSkillVersionInput
): Promise<ApplySkillImprovementResult> {
  if ((!input.storageScope || input.storageScope === "workspace") && isMarketManagedWorkspaceSkill(input.workspaceSlug, input.skillSlug)) {
    return { success: false, error: "市场管理的 Skill 请在技能市场中管理" };
  }
  return restoreSkillVersion({
    skillPath: resolveWorkspaceSkillFile(input),
    filename: input.filename
  });
}

interface SkillUsageRecord {
  ts: number;
  sessionId: string;
}

async function readSkillUsageRecords(skillPath: string): Promise<SkillUsageRecord[]> {
  try {
    const raw = await readFile(join(dirname(skillPath), "usage.jsonl"), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseSkillUsageRecord)
      .filter((record): record is SkillUsageRecord => record !== null);
  } catch {
    return [];
  }
}

function parseSkillUsageRecord(line: string): SkillUsageRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.ts !== "number" || typeof parsed.sessionId !== "string" || !parsed.sessionId.trim()) {
      return null;
    }
    return {
      ts: parsed.ts,
      sessionId: parsed.sessionId
    };
  } catch {
    return null;
  }
}

function pickRecentUsageSessionIds(records: SkillUsageRecord[], maxSessions: number): string[] {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  const limit = Math.max(0, maxSessions);

  for (const record of [...records].sort((a, b) => b.ts - a.ts)) {
    if (seen.has(record.sessionId)) continue;
    seen.add(record.sessionId);
    sessionIds.push(record.sessionId);
    if (sessionIds.length >= limit) break;
  }

  return sessionIds;
}

function toSkillImprovementMessages(messages: AgentMessage[]): SkillImprovementMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

async function listThreadUsedWorkspaceSkills(input: {
  workspaceSlug: string;
  cwd?: string;
  threadId: string;
}): Promise<Array<{
  storageScope: SkillStorageScope;
  cwd?: string;
  skillSlug: string;
  skillPath: string;
  usageCount: number;
  lastUsedAt: number;
}>> {
  const projectCwd = input.cwd?.trim() ? resolve(input.cwd) : undefined;
  const roots: Array<{ storageScope: SkillStorageScope; skillsDir: string; cwd?: string }> = [
    { storageScope: "user", skillsDir: getUserSkillsDir() },
    { storageScope: "user", skillsDir: getAliceUserSkillsDir() },
    ...(projectCwd
      ? [
        { storageScope: "project" as const, skillsDir: join(projectCwd, ".lume", "skills"), cwd: projectCwd },
        { storageScope: "project" as const, skillsDir: join(projectCwd, ".alice", "skills"), cwd: projectCwd }
      ]
      : []),
    { storageScope: "workspace", skillsDir: getWorkspaceSkillsDir(input.workspaceSlug) }
  ];
  const used: Array<{
    storageScope: SkillStorageScope;
    cwd?: string;
    skillSlug: string;
    skillPath: string;
    usageCount: number;
    lastUsedAt: number;
  }> = [];

  for (const root of roots) {
    used.push(...await listThreadUsedSkillsFromDir({
      ...input,
      ...root
    }));
  }

  const byScopeSlug = new Map<string, (typeof used)[number]>();
  for (const item of used) {
    byScopeSlug.set(`${item.storageScope}:${item.skillSlug}`, item);
  }

  return Array.from(byScopeSlug.values())
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.skillSlug.localeCompare(b.skillSlug));
}

async function listThreadUsedSkillsFromDir(input: {
  workspaceSlug: string;
  threadId: string;
  cwd?: string;
  storageScope: SkillStorageScope;
  skillsDir: string;
}): Promise<Array<{
  storageScope: SkillStorageScope;
  cwd?: string;
  skillSlug: string;
  skillPath: string;
  usageCount: number;
  lastUsedAt: number;
}>> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(input.skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const used: Array<{
    storageScope: SkillStorageScope;
    cwd?: string;
    skillSlug: string;
    skillPath: string;
    usageCount: number;
    lastUsedAt: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (input.storageScope === "workspace" && isMarketManagedWorkspaceSkill(input.workspaceSlug, entry.name)) continue;

    let skillPath: string;
    try {
      skillPath = resolveWorkspaceSkillFile({
        workspaceSlug: input.workspaceSlug,
        skillSlug: entry.name,
        storageScope: input.storageScope,
        cwd: input.cwd
      });
    } catch {
      continue;
    }

    const usageRecords = await readSkillUsageRecords(skillPath);
    const threadRecords = usageRecords.filter((record) => record.sessionId === input.threadId);
    if (threadRecords.length === 0) continue;
    used.push({
      storageScope: input.storageScope,
      ...(input.storageScope === "project" && input.cwd ? { cwd: resolve(input.cwd) } : {}),
      skillSlug: entry.name,
      skillPath,
      usageCount: threadRecords.length,
      lastUsedAt: Math.max(...threadRecords.map((record) => record.ts))
    });
  }

  return used;
}

function resolveSkillImprovementModelRef(input: {
  workspaceSlug?: string;
  modelRef?: string;
  getEffectiveConfig?: (workspaceSlug?: string) => SkillEvolutionEffectiveConfigLike;
}): string | undefined {
  const explicit = normalizeOptionalString(input.modelRef);
  if (explicit) return explicit;

  const effective = (input.getEffectiveConfig ?? getEffectiveLumeConfig)(input.workspaceSlug);
  return normalizeOptionalString(effective.models?.agent?.defaultModelRef)
    ?? normalizeOptionalString(effective.models?.chat?.defaultModelRef);
}

function defaultResolveBinding(modelRef: string): SkillModelBinding | null {
  return resolveChannelModelBinding(modelRef, "chat");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
