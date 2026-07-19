import { resolve } from "node:path";
import {
  formatLumePluginReference,
  formatLumeSkillReference,
  loadFilesystemSkills,
  normalizeLumeCapabilityReferences,
  type LumeCapabilityReference,
  type SkillInvocationDescriptor,
  type SkillDefinition,
} from "@lume/agent-sdk";
import type {
  AgentInvocableCapabilityItem,
  AgentCapabilityReferenceView,
  AgentPluginDiagnostic,
  ListInvocableCapabilitiesInput,
  ListInvocableCapabilitiesResult,
  SkillStorageScope,
} from "@lume/shared";
import { getAgentWorkspaceBySlug } from "./agent-workspace-manager";
import {
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceSkillsDir,
} from "../infra/config-paths";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig } from "../system/lume-config-service";
import { SidecarPluginManager } from "../agent-runtime/plugins/plugin-manager.js";
import { resolvePluginCapabilities } from "../agent-runtime/plugins/capability-resolver.js";
import { summarizePluginMarketplace } from "../plugins/plugin-market-service";

interface SkillRoot {
  path: string;
  scope: Exclude<SkillStorageScope, "plugin">;
  priority: number;
}

interface SkillCandidate {
  definition: SkillDefinition;
  root: SkillRoot;
}

export class CapabilityReferenceResolutionError extends Error {
  constructor(
    public readonly code: "too_many_refs" | "not_callable" | "budget_exceeded" | "incompatible_modes",
    message: string,
    public readonly uri?: string,
  ) {
    super(message);
    this.name = "CapabilityReferenceResolutionError";
  }
}

export interface MaterializedCapabilityContext {
  context: string;
  allowedTools?: string[];
  fingerprints: Array<{ uri: string; fingerprint: string }>;
  references: AgentCapabilityReferenceView[];
}

function uniqueRoots(roots: SkillRoot[]): SkillRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveSkillRoots(input: ListInvocableCapabilitiesInput): SkillRoot[] {
  if (!input.workspaceSlug) return [];
  const projectPath = input.cwd?.trim() || getAgentWorkspaceBySlug(input.workspaceSlug)?.projectPath?.trim();
  return uniqueRoots([
    { path: getDefaultSkillsDir(), scope: "workspace", priority: 10 },
    { path: getUserSkillsDir(), scope: "user", priority: 20 },
    { path: getAliceUserSkillsDir(), scope: "user", priority: 20 },
    ...(projectPath ? [
      { path: resolve(projectPath, ".alice", "skills"), scope: "project" as const, priority: 30 },
      { path: resolve(projectPath, ".lume", "skills"), scope: "project" as const, priority: 30 },
    ] : []),
    { path: getWorkspaceSkillsDir(input.workspaceSlug), scope: "workspace", priority: 40 },
  ]);
}

function normalizeConfiguredSkills(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean));
}

async function loadSkillCandidates(input: ListInvocableCapabilitiesInput): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = [];
  for (const root of resolveSkillRoots(input)) {
    const definitions = await loadFilesystemSkills({ cwd: root.path, roots: [root.path] });
    for (const definition of definitions) candidates.push({ definition, root });
  }
  return candidates;
}

export function buildInvocableSkillCatalog(
  candidates: SkillCandidate[],
  config: { enabled: Set<string>; disabled: Set<string> },
): AgentInvocableCapabilityItem[] {
  const bySlug = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    const list = bySlug.get(candidate.definition.name) ?? [];
    list.push(candidate);
    bySlug.set(candidate.definition.name, list);
  }

  return [...bySlug.entries()].map(([skillSlug, entries]) => {
    const highestPriority = Math.max(...entries.map((entry) => entry.root.priority));
    const winners = entries.filter((entry) => entry.root.priority === highestPriority);
    const winner = winners[0]!;
    const explicitlyDisabled = config.disabled.has(skillSlug)
      || (config.enabled.size > 0 && !config.enabled.has(skillSlug) && winner.root.priority !== 20 && winner.root.priority !== 30);
    const ambiguous = winners.length > 1;
    const hasDescriptor = Boolean(winner.definition.invocationDescriptor);
    const callable = !ambiguous
      && !explicitlyDisabled
      && hasDescriptor
      && winner.definition.userInvocable !== false
      && (!winner.definition.isEnabled || winner.definition.isEnabled());
    const displayName = winner.definition.aliases?.find((alias) => alias.trim()) ?? winner.definition.name;
    return {
      kind: "skill" as const,
      uri: formatLumeSkillReference(skillSlug),
      displayName,
      description: winner.definition.description,
      source: winner.definition.sourcePath ?? winner.root.path,
      scope: winner.root.scope,
      ...(winner.definition.version ? { version: winner.definition.version } : {}),
      ...(winner.definition.invocationDescriptor ? { fingerprint: winner.definition.invocationDescriptor.fingerprint } : {}),
      callable,
      ...(!callable ? {
        unavailableReason: ambiguous
          ? "ambiguous" as const
          : explicitlyDisabled
            ? "disabled" as const
            : "legacy-definition" as const,
      } : {}),
      skillSlug,
    };
  }).sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export function isPluginEnabledForComposer(
  plugin: { pluginId: string; builtin?: boolean },
  config: { enabled: string[]; disabled: string[] },
): boolean {
  if (plugin.builtin) return true;
  if (config.disabled.includes(plugin.pluginId)) return false;
  return config.enabled.length === 0 || config.enabled.includes(plugin.pluginId);
}

export async function listInvocableCapabilities(
  input: ListInvocableCapabilitiesInput,
): Promise<ListInvocableCapabilitiesResult> {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const skills = input.workspaceSlug
    ? await loadSkillCandidates(input).then((candidates) => {
        const config = getEffectiveLumeConfig(input.workspaceSlug).skills;
        return buildInvocableSkillCatalog(candidates, {
          enabled: normalizeConfiguredSkills(config?.enabled),
          disabled: normalizeConfiguredSkills(config?.disabled),
        });
      })
    : [];

  const pluginConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
  const manager = new SidecarPluginManager();
  // Composer discovery must include disabled/unselected plugins so the panel can
  // explain their state. Runtime execution still uses the filtered registry.
  const registered = await manager.listRegisteredResult({
    enabled: [],
    disabled: [],
    directories: pluginConfig.directories,
  });
  diagnostics.push(...registered.diagnostics as AgentPluginDiagnostic[]);
  const resolved = await resolvePluginCapabilities(registered.plugins);
  diagnostics.push(...resolved.diagnostics as AgentPluginDiagnostic[]);
  const resolvedByPlugin = new Map(resolved.capabilities.map((item) => [item.pluginId, item]));
  const plugins: AgentInvocableCapabilityItem[] = [];

  for (const plugin of registered.plugins) {
    const capability = resolvedByPlugin.get(plugin.pluginId);
    const icon = plugin.marketplace?.icon
      ? summarizePluginMarketplace(plugin.root, plugin.marketplace).icon
      : undefined;
    const resolvedSkills = capability?.skills ?? [];
    const invocableSkills = resolvedSkills.filter((skill) => skill.definition.invocationDescriptor);
    const configuredEnabled = isPluginEnabledForComposer(plugin, pluginConfig);
    const permissionLoaded = plugin.permissionState?.state === "loaded";
    const pluginCallable = configuredEnabled && permissionLoaded && invocableSkills.length > 0;
    plugins.push({
      kind: "plugin",
      uri: formatLumePluginReference(plugin.pluginId),
      displayName: plugin.displayName ?? plugin.name,
      description: plugin.description,
      source: plugin.root,
      scope: input.workspaceSlug && pluginConfig.enabled.includes(plugin.pluginId) ? "workspace-plugin" : "global-plugin",
      version: plugin.version,
      callable: pluginCallable,
      ...(!pluginCallable ? {
        unavailableReason: !configuredEnabled
          ? "disabled" as const
          : permissionLoaded
            ? "no-invocable-skills" as const
            : "needs-review" as const,
      } : {}),
      pluginId: plugin.pluginId,
      ...(icon ? { icon } : {}),
    });

    for (const skill of resolvedSkills) {
      const descriptor = skill.definition.invocationDescriptor;
      const callable = configuredEnabled && permissionLoaded && Boolean(descriptor);
      plugins.push({
        kind: "plugin-skill",
        uri: formatLumeSkillReference(skill.originalName, plugin.pluginId),
        displayName: skill.definition.aliases?.find((alias) => alias.trim()) ?? skill.originalName,
        description: skill.definition.description,
        source: skill.sourcePath,
        scope: input.workspaceSlug && pluginConfig.enabled.includes(plugin.pluginId) ? "workspace-plugin" : "global-plugin",
        version: skill.definition.version ?? plugin.version,
        ...(descriptor ? { fingerprint: descriptor.fingerprint } : {}),
        callable,
        ...(!callable ? {
          unavailableReason: !configuredEnabled
            ? "disabled" as const
            : permissionLoaded
              ? "legacy-definition" as const
              : "needs-review" as const,
        } : {}),
        pluginId: plugin.pluginId,
        skillSlug: skill.originalName,
        ...(icon ? { icon } : {}),
      });
    }
  }

  return {
    capabilities: [...skills, ...plugins].sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN")),
    diagnostics,
  };
}

function selectSkillWinner(candidates: SkillCandidate[], slug: string): SkillCandidate | undefined {
  const matching = candidates.filter((candidate) => candidate.definition.name === slug);
  if (matching.length === 0) return undefined;
  const priority = Math.max(...matching.map((candidate) => candidate.root.priority));
  const winners = matching.filter((candidate) => candidate.root.priority === priority);
  return winners.length === 1 ? winners[0] : undefined;
}

function intersectAllowedTools(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (!next || next.length === 0) return current;
  if (!current) return [...new Set(next)];
  const nextSet = new Set(next);
  return current.filter((tool) => nextSet.has(tool));
}

function materializeDescriptor(descriptor: SkillInvocationDescriptor, args: string): string {
  return descriptor.promptTemplate.replaceAll(descriptor.argumentToken, args);
}

export async function materializeCapabilityReferences(input: {
  workspaceSlug?: string;
  cwd?: string;
  references: LumeCapabilityReference[];
  modelMessage: string;
}): Promise<MaterializedCapabilityContext> {
  const references = normalizeLumeCapabilityReferences(input.references);
  if (references.length === 0) return { context: "", fingerprints: [], references: [] };
  if (references.length > 8) {
    throw new CapabilityReferenceResolutionError("too_many_refs", "每条消息最多可引用 8 个技能或插件");
  }

  const catalog = await listInvocableCapabilities({ workspaceSlug: input.workspaceSlug, cwd: input.cwd });
  const catalogByUri = new Map(catalog.capabilities.map((item) => [item.uri, item]));
  const skillCandidates = input.workspaceSlug ? await loadSkillCandidates(input) : [];
  const pluginConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
  const registered = await new SidecarPluginManager().listRegistered({
    enabled: pluginConfig.enabled,
    disabled: pluginConfig.disabled,
    directories: pluginConfig.directories,
  });
  const pluginCapabilities = await resolvePluginCapabilities(registered);
  const pluginsById = new Map(pluginCapabilities.capabilities.map((item) => [item.pluginId, item]));
  const prompts: Array<{ uri: string; prompt: string; descriptor: SkillInvocationDescriptor }> = [];

  const pushDescriptor = (uri: string, descriptor: SkillInvocationDescriptor | undefined) => {
    if (!descriptor) throw new CapabilityReferenceResolutionError("not_callable", `能力当前不可调用：${uri}`, uri);
    const prompt = materializeDescriptor(descriptor, input.modelMessage.trim());
    if (Buffer.byteLength(prompt, "utf-8") > 64 * 1024) {
      throw new CapabilityReferenceResolutionError("budget_exceeded", `能力内容超过 64 KiB：${uri}`, uri);
    }
    prompts.push({ uri, prompt, descriptor });
  };

  for (const reference of references) {
    const item = catalogByUri.get(reference.uri);
    if (!item?.callable) {
      throw new CapabilityReferenceResolutionError("not_callable", `能力当前不可调用：${reference.uri}`, reference.uri);
    }
    if (reference.kind === "plugin") {
      const plugin = pluginsById.get(reference.pluginId);
      const skills = plugin?.skills.filter((skill) => skill.definition.invocationDescriptor) ?? [];
      if (skills.length === 0) {
        throw new CapabilityReferenceResolutionError("not_callable", `插件没有可调用技能：${reference.uri}`, reference.uri);
      }
      for (const skill of skills) pushDescriptor(reference.uri, skill.definition.invocationDescriptor);
      continue;
    }
    if (reference.pluginId) {
      const skill = pluginsById.get(reference.pluginId)?.skills.find((candidate) => candidate.originalName === reference.skillSlug);
      pushDescriptor(reference.uri, skill?.definition.invocationDescriptor);
      continue;
    }
    pushDescriptor(reference.uri, selectSkillWinner(skillCandidates, reference.skillSlug)?.definition.invocationDescriptor);
  }

  const modes = new Set(prompts.map((item) => `${item.descriptor.context}:${item.descriptor.agent ?? ""}`));
  if (modes.size > 1) {
    throw new CapabilityReferenceResolutionError("incompatible_modes", "所选技能的执行模式不兼容，请分开发送");
  }
  const context = prompts.map((item) => [
    `<lume-capability uri="${item.uri}">`,
    item.prompt,
    "</lume-capability>",
  ].join("\n")).join("\n\n");
  if (Buffer.byteLength(context, "utf-8") > 128 * 1024) {
    throw new CapabilityReferenceResolutionError("budget_exceeded", "能力上下文总大小超过 128 KiB，请减少引用数量");
  }
  let allowedTools: string[] | undefined;
  for (const item of prompts) allowedTools = intersectAllowedTools(allowedTools, item.descriptor.allowedTools);
  return {
    context,
    ...(allowedTools ? { allowedTools } : {}),
    fingerprints: prompts.map((item) => ({ uri: item.uri, fingerprint: item.descriptor.fingerprint })),
    references: references.map((reference) => {
      const item = catalogByUri.get(reference.uri)!;
      return {
        uri: item.uri,
        kind: item.kind,
        displayName: item.displayName,
        ...(item.icon ? { icon: item.icon } : {}),
        callable: item.callable,
      };
    }),
  };
}
