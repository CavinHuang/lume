"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, Globe, MessageSquare, Pencil, Plug, Plus, Puzzle, RefreshCw, Sparkles, Store, Trash2 } from "lucide-react";
import type {
  GlobalDiscoverySnapshot,
  GlobalPluginMarketplaceDetail,
  McpServerEntry,
  SkillMeta,
  WorkspaceMcpConfig
} from "@lume/shared";
import {
  activeViewAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  appModeAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom
} from "@/atoms";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  createAgentSession,
  deleteAgentWorkspaceSkill,
  getAgentWorkspaceMcpConfig,
  getAgentGlobalDiscoverySnapshot,
  getAgentGlobalMarketplaceDetail,
  installAgentGlobalPlugin,
  importGlobalMcpToWorkspace,
  importGlobalSkillToWorkspace,
  listAgentSessions,
  listAgentWorkspaceSkills,
  rescanAgentGlobalDiscoverySnapshot,
  saveAgentWorkspaceMcpConfig
} from "@/lib/desktop-api";
import { McpServerForm } from "./McpServerForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type ViewMode = "list" | "create" | "edit";

type EditingServer = {
  name: string;
  entry: McpServerEntry;
};

const TRANSPORT_LABELS: Record<string, string> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE"
};

export function AgentSettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const agentChannelId = useAtomValue(agentChannelIdAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId]
  );

  const setAgentSessions = useSetAtom(agentSessionsAtom);
  const setCurrentSessionId = useSetAtom(currentAgentSessionIdAtom);
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom);
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom);

  const workspaceSlug = workspace?.slug ?? "";
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingServer, setEditingServer] = useState<EditingServer | null>(null);
  const [mcpConfig, setMcpConfig] = useState<WorkspaceMcpConfig>({ servers: {} });
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalDiscovery, setGlobalDiscovery] = useState<GlobalDiscoverySnapshot | null>(null);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalRefreshing, setGlobalRefreshing] = useState(false);
  const [importingGlobalMcpId, setImportingGlobalMcpId] = useState<string | null>(null);
  const [importingGlobalSkillId, setImportingGlobalSkillId] = useState<string | null>(null);
  const [loadingMarketplaceId, setLoadingMarketplaceId] = useState<string | null>(null);
  const [selectedMarketplaceDetail, setSelectedMarketplaceDetail] = useState<GlobalPluginMarketplaceDetail | null>(null);
  const [marketplaceDialogOpen, setMarketplaceDialogOpen] = useState(false);
  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  const [installingPluginKey, setInstallingPluginKey] = useState<string | null>(null);
  const [marketplaceActionError, setMarketplaceActionError] = useState<string | null>(null);

  const loadData = async (): Promise<void> => {
    if (!workspaceSlug) {
      setLoading(false);
      setGlobalLoading(false);
      return;
    }
    try {
      const [config, skillList, globalSnapshot] = await Promise.all([
        getAgentWorkspaceMcpConfig(workspaceSlug),
        listAgentWorkspaceSkills(workspaceSlug),
        getAgentGlobalDiscoverySnapshot()
      ]);
      setMcpConfig(config);
      setSkills(skillList);
      setGlobalDiscovery(globalSnapshot);
    } catch (error) {
      console.error("[AgentSettings] load workspace data failed", error);
    } finally {
      setLoading(false);
      setGlobalLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [workspaceSlug, capabilitiesVersion]);

  const buildMcpPrompt = (): string => {
    const configPath = `~/.lume/agent-workspaces/${workspaceSlug}/mcp.json`;
    const currentConfig = JSON.stringify(mcpConfig, null, 2);

    return `请帮我配置当前工作区的 MCP 服务器，你要主动来帮我实现，你可以采用联网搜索深度研究来尝试，当前环境已经有 Claude Agent SDK 了，除非不确定的时候才来问我，否则默认将帮我完成安装，而不是指导我。

## 工作区信息
- 工作区: ${workspace?.name}
- MCP 配置文件: ${configPath}

## 当前配置
\`\`\`json
${currentConfig}
\`\`\`

## 配置格式
mcp.json 格式如下：
\`\`\`json
{
  "servers": {
    "服务器名称": {
      "type": "stdio | http | sse",
      "command": "可执行命令",
      "args": ["参数1", "参数2"],
      "env": { "KEY": "VALUE" },
      "url": "http://...",
      "headers": { "Key": "Value" },
      "enabled": true
    }
  }
}
\`\`\`
其中 stdio 类型使用 command/args/env，http/sse 类型使用 url/headers。

请读取当前配置文件，根据我的需求添加或修改 MCP 服务器，然后写回文件。`;
  };

  const buildSkillPrompt = (): string => {
    const skillsDir = `~/.lume/agent-workspaces/${workspaceSlug}/skills/`;
    const skillList = skills.length > 0
      ? skills.map((item) => `- ${item.name}: ${item.description ?? "无描述"}`).join("\n")
      : "暂无 Skill";

    return `请帮我配置当前工作区的 Skills，你要主动来帮我实现，你可以采用联网搜索深度研究来尝试，当前环境已经有 Claude Agent SDK 了，除非不确定的时候才来问我，否则默认将帮我完成安装，而不是指导我。

## 工作区信息
- 工作区: ${workspace?.name}
- Skills 目录: ${skillsDir}

## Skill 格式
每个 Skill 是 skills/ 目录下的一个子目录，目录名即 slug。
目录内包含 SKILL.md 文件，格式：

\`\`\`markdown
---
name: Skill 显示名称
description: 简要描述
---

Skill 的详细指令内容...
\`\`\`

## 当前 Skills
${skillList}

请查看 skills/ 目录了解现有配置，根据我的需求创建或编辑 Skill。`;
  };

  const handleConfigViaChat = async (promptMessage: string): Promise<void> => {
    if (!agentChannelId) {
      window.alert("请先在渠道设置中选择 Agent 供应商");
      return;
    }

    try {
      const session = await createAgentSession({
        channelId: agentChannelId,
        workspaceId: currentWorkspaceId ?? undefined
      });

      const sessions = await listAgentSessions();
      setAgentSessions(sessions);
      setCurrentSessionId(session.id);
      setPendingPrompt({ sessionId: session.id, message: promptMessage });
      setAppMode("agent");
      setActiveView("conversations");
    } catch (error) {
      console.error("[AgentSettings] create config session failed", error);
    }
  };

  const handleDeleteServer = async (serverName: string): Promise<void> => {
    if (!window.confirm(`确定删除 MCP 服务器「${serverName}」？此操作不可恢复。`)) return;
    const nextServers = { ...mcpConfig.servers };
    delete nextServers[serverName];
    const nextConfig: WorkspaceMcpConfig = { servers: nextServers };
    await saveAgentWorkspaceMcpConfig(workspaceSlug, nextConfig);
    setMcpConfig(nextConfig);
    bumpCapabilitiesVersion((v) => v + 1);
  };

  const handleToggleServer = async (serverName: string): Promise<void> => {
    const entry = mcpConfig.servers[serverName];
    if (!entry) return;
    const nextConfig: WorkspaceMcpConfig = {
      servers: {
        ...mcpConfig.servers,
        [serverName]: { ...entry, enabled: !entry.enabled }
      }
    };
    await saveAgentWorkspaceMcpConfig(workspaceSlug, nextConfig);
    setMcpConfig(nextConfig);
    bumpCapabilitiesVersion((v) => v + 1);
  };

  const handleDeleteSkill = async (skillSlug: string, skillName: string): Promise<void> => {
    if (!window.confirm(`确定删除 Skill「${skillName}」？此操作不可恢复。`)) return;
    await deleteAgentWorkspaceSkill(workspaceSlug, skillSlug);
    setSkills((prev) => prev.filter((item) => item.slug !== skillSlug));
    bumpCapabilitiesVersion((v) => v + 1);
  };

  const handleRefreshGlobalDiscovery = async (): Promise<void> => {
    setGlobalRefreshing(true);
    try {
      const snapshot = await rescanAgentGlobalDiscoverySnapshot();
      setGlobalDiscovery(snapshot);
      if (selectedMarketplaceDetail) {
        const exists = snapshot.pluginMarketplaces.some((item) => item.id === selectedMarketplaceDetail.marketplace.id);
        if (!exists) {
          setSelectedMarketplaceDetail(null);
        }
      }
    } catch (error) {
      console.error("[AgentSettings] refresh global discovery failed", error);
    } finally {
      setGlobalRefreshing(false);
    }
  };

  const handleOpenMarketplaceDetail = async (marketplaceId: string): Promise<void> => {
    setLoadingMarketplaceId(marketplaceId);
    setMarketplaceActionError(null);
    try {
      const detail = await getAgentGlobalMarketplaceDetail(marketplaceId);
      setSelectedMarketplaceDetail(detail);
      setMarketplaceDialogOpen(true);
      setMarketplaceSearch("");
    } catch (error) {
      console.error("[AgentSettings] load marketplace detail failed", error);
    } finally {
      setLoadingMarketplaceId(null);
    }
  };

  const handleInstallMarketplacePlugin = async (pluginName: string): Promise<void> => {
    if (!selectedMarketplaceDetail) return;
    const pluginKey = `${selectedMarketplaceDetail.marketplace.id}:${pluginName}`;
    setInstallingPluginKey(pluginKey);
    setMarketplaceActionError(null);
    try {
      await installAgentGlobalPlugin({
        marketplaceId: selectedMarketplaceDetail.marketplace.id,
        pluginName,
        scope: "user"
      });
      const [detail, snapshot] = await Promise.all([
        getAgentGlobalMarketplaceDetail(selectedMarketplaceDetail.marketplace.id),
        getAgentGlobalDiscoverySnapshot()
      ]);
      setSelectedMarketplaceDetail(detail);
      setGlobalDiscovery(snapshot);
      bumpCapabilitiesVersion((v) => v + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMarketplaceActionError(message);
      console.error("[AgentSettings] install marketplace plugin failed", error);
    } finally {
      setInstallingPluginKey(null);
    }
  };

  const handleImportGlobalMcp = async (mcpId: string, mcpName: string): Promise<void> => {
    setImportingGlobalMcpId(mcpId);
    try {
      const firstTry = await importGlobalMcpToWorkspace({
        workspaceSlug,
        mcpId,
        overwrite: false
      });
      if (firstTry.imported) {
        await loadData();
        bumpCapabilitiesVersion((v) => v + 1);
        return;
      }
      if (!window.confirm(`工作区已存在同名 MCP「${mcpName}」，是否覆盖？`)) return;
      await importGlobalMcpToWorkspace({
        workspaceSlug,
        mcpId,
        overwrite: true
      });
      await loadData();
      bumpCapabilitiesVersion((v) => v + 1);
    } catch (error) {
      console.error("[AgentSettings] import global MCP failed", error);
    } finally {
      setImportingGlobalMcpId(null);
    }
  };

  const handleImportGlobalSkill = async (skillId: string, skillName: string): Promise<void> => {
    setImportingGlobalSkillId(skillId);
    try {
      const firstTry = await importGlobalSkillToWorkspace({
        workspaceSlug,
        skillId,
        overwrite: false
      });
      if (firstTry.imported) {
        await loadData();
        bumpCapabilitiesVersion((v) => v + 1);
        return;
      }
      if (!window.confirm(`工作区已存在同名 Skill「${skillName}」，是否覆盖？`)) return;
      await importGlobalSkillToWorkspace({
        workspaceSlug,
        skillId,
        overwrite: true
      });
      await loadData();
      bumpCapabilitiesVersion((v) => v + 1);
    } catch (error) {
      console.error("[AgentSettings] import global Skill failed", error);
    } finally {
      setImportingGlobalSkillId(null);
    }
  };

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen size={48} className="mb-4 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">请先在 Agent 模式下选择或创建一个工作区</p>
      </div>
    );
  }

  if (viewMode === "create" || viewMode === "edit") {
    return (
      <McpServerForm
        server={editingServer}
        workspaceSlug={workspaceSlug}
        onSaved={() => {
          setViewMode("list");
          setEditingServer(null);
          void loadData();
          bumpCapabilitiesVersion((v) => v + 1);
        }}
        onCancel={() => {
          setViewMode("list");
          setEditingServer(null);
        }}
      />
    );
  }

  const serverEntries = Object.entries(mcpConfig.servers ?? {});
  const globalMcpServers = globalDiscovery?.mcpServers ?? [];
  const globalSkills = globalDiscovery?.skills ?? [];
  const globalPluginMarketplaces = globalDiscovery?.pluginMarketplaces ?? [];
  const globalPlugins = globalDiscovery?.plugins ?? [];
  const filteredMarketplacePlugins = useMemo(() => {
    if (!selectedMarketplaceDetail) return [];
    const q = marketplaceSearch.trim().toLowerCase();
    if (!q) return selectedMarketplaceDetail.plugins;
    return selectedMarketplaceDetail.plugins.filter((plugin) =>
      plugin.name.toLowerCase().includes(q)
      || (plugin.description ?? "").toLowerCase().includes(q)
    );
  }, [selectedMarketplaceDetail, marketplaceSearch]);
  const globalScannedAt = globalDiscovery?.scannedAt
    ? new Date(globalDiscovery.scannedAt).toLocaleString()
    : "未扫描";

  return (
    <div className="space-y-8">
      <SettingsSection
        title="MCP 服务器"
        description={`当前工作区: ${workspace.name}`}
        action={
          <Button size="sm" type="button" onClick={() => setViewMode("create")}>
            <Plus size={16} />
            <span>添加服务器</span>
          </Button>
        }
      >
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : serverEntries.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="py-12 text-center text-sm text-muted-foreground">
              还没有配置任何 MCP 服务器，点击上方"添加服务器"开始
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {serverEntries.map(([name, entry]) => (
              <SettingsRow
                key={name}
                label={name}
                icon={<Plug size={18} className="text-blue-500" />}
                description={entry.type === "stdio" ? entry.command : entry.url}
                className="group"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {TRANSPORT_LABELS[entry.type] ?? entry.type}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingServer({ name, entry });
                      setViewMode("edit");
                    }}
                    className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-muted/50 hover:text-foreground"
                    title="编辑"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleDeleteServer(name); }}
                    className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                  <Switch checked={entry.enabled} onCheckedChange={() => { void handleToggleServer(name); }} />
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      <Button size="sm" className="w-full" type="button" onClick={() => { void handleConfigViaChat(buildMcpPrompt()); }}>
        <MessageSquare size={14} />
        <span>跟 Lume Agent 对话完成配置</span>
      </Button>

      <SettingsSection title="Skills" description="将 SKILL.md 放入工作区 skills/ 目录即可被 Agent 自动发现">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : skills.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="py-8 text-center text-sm text-muted-foreground">暂无 Skill</div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {skills.map((skill) => (
              <SettingsRow
                key={skill.slug}
                label={skill.name}
                icon={<Sparkles size={18} className="text-amber-500" />}
                description={skill.description ?? skill.slug}
                className="group"
              >
                <button
                  type="button"
                  onClick={() => { void handleDeleteSkill(skill.slug, skill.name); }}
                  className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
        <p className="px-1 text-xs text-muted-foreground">路径: ~/.lume/agent-workspaces/{workspaceSlug}/skills/</p>

        <Button size="sm" className="w-full" type="button" onClick={() => { void handleConfigViaChat(buildSkillPrompt()); }}>
          <MessageSquare size={14} />
          <span>跟 Lume Agent 对话完成配置</span>
        </Button>
      </SettingsSection>

      <SettingsSection
        title="全局发现"
        description={`来源: ~/.claude · 最近扫描: ${globalScannedAt}`}
        action={(
          <Button size="sm" type="button" variant="outline" onClick={() => { void handleRefreshGlobalDiscovery(); }}>
            <RefreshCw size={14} className={globalRefreshing ? "animate-spin" : ""} />
            <span>重新扫描</span>
          </Button>
        )}
      >
        {globalLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : (
          <div className="space-y-4">
            <SettingsCard divided={false}>
              <div className="px-4 py-3 text-xs text-muted-foreground">
                已发现 {globalMcpServers.length} 个 MCP，{globalSkills.length} 个 Skill，{globalPluginMarketplaces.length} 个 Marketplace，{globalPlugins.length} 个 Plugin
              </div>
            </SettingsCard>

            <SettingsSection title="全局 MCP" description="可一键导入到当前工作区">
              {globalMcpServers.length === 0 ? (
                <SettingsCard divided={false}>
                  <div className="py-6 text-center text-sm text-muted-foreground">未发现全局 MCP</div>
                </SettingsCard>
              ) : (
                <SettingsCard>
                  {globalMcpServers.map((server) => (
                    <SettingsRow
                      key={server.id}
                      label={server.name}
                      icon={<Globe size={18} className="text-sky-500" />}
                      description={server.type === "stdio" ? server.command : server.url}
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        disabled={importingGlobalMcpId === server.id}
                        onClick={() => { void handleImportGlobalMcp(server.id, server.name); }}
                      >
                        导入到工作区
                      </Button>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              )}
            </SettingsSection>

            <SettingsSection title="全局 Skills" description="可一键导入到当前工作区">
              {globalSkills.length === 0 ? (
                <SettingsCard divided={false}>
                  <div className="py-6 text-center text-sm text-muted-foreground">未发现全局 Skills</div>
                </SettingsCard>
              ) : (
                <SettingsCard>
                  {globalSkills.map((skill) => (
                    <SettingsRow
                      key={skill.id}
                      label={skill.name}
                      icon={<Sparkles size={18} className="text-amber-500" />}
                      description={skill.description ?? skill.slug}
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        disabled={importingGlobalSkillId === skill.id}
                        onClick={() => { void handleImportGlobalSkill(skill.id, skill.name); }}
                      >
                        导入到工作区
                      </Button>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              )}
            </SettingsSection>

            <SettingsSection title="Plugin Marketplace" description="全局已登记的插件市场">
              {globalPluginMarketplaces.length === 0 ? (
                <SettingsCard divided={false}>
                  <div className="py-6 text-center text-sm text-muted-foreground">未发现 Marketplace</div>
                </SettingsCard>
              ) : (
                <SettingsCard>
                  {globalPluginMarketplaces.map((marketplace) => (
                    <SettingsRow
                      key={marketplace.id}
                      label={marketplace.id}
                      icon={<Store size={18} className="text-emerald-500" />}
                      description={`${marketplace.sourceType}: ${marketplace.sourceRef || marketplace.installLocation}`}
                    >
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        disabled={loadingMarketplaceId === marketplace.id}
                        onClick={() => { void handleOpenMarketplaceDetail(marketplace.id); }}
                      >
                        {loadingMarketplaceId === marketplace.id ? "加载中..." : "查看详情"}
                      </Button>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              )}
            </SettingsSection>

            <SettingsSection title="Plugins" description="全局已安装插件（按 marketplace 聚合）">
              {globalPlugins.length === 0 ? (
                <SettingsCard divided={false}>
                  <div className="py-6 text-center text-sm text-muted-foreground">未发现 Plugins</div>
                </SettingsCard>
              ) : (
                <SettingsCard>
                  {globalPlugins.map((plugin) => (
                    <SettingsRow
                      key={plugin.id}
                      label={plugin.pluginName}
                      icon={<Puzzle size={18} className="text-violet-500" />}
                      description={`${plugin.marketplaceId} · 安装 ${plugin.installCount} 次 · 范围 ${plugin.scopes.join(", ") || "-"}`}
                    />
                  ))}
                </SettingsCard>
              )}
            </SettingsSection>

            {globalDiscovery?.warnings && globalDiscovery.warnings.length > 0 ? (
              <SettingsCard divided={false}>
                <div className="space-y-1 px-4 py-3 text-xs text-amber-700">
                  {globalDiscovery.warnings.map((warning, index) => (
                    <p key={`${warning.code}-${index}`}>
                      [{warning.code}] {warning.message}
                    </p>
                  ))}
                </div>
              </SettingsCard>
            ) : null}
          </div>
        )}
      </SettingsSection>

      <Dialog
        open={marketplaceDialogOpen}
        onOpenChange={(open) => {
          setMarketplaceDialogOpen(open);
          if (!open) {
            setMarketplaceSearch("");
            setMarketplaceActionError(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl overflow-hidden border-border/70 bg-background/95 p-0 backdrop-blur-md">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle>
              Marketplace 详情
              {selectedMarketplaceDetail ? ` · ${selectedMarketplaceDetail.marketplace.id}` : ""}
            </DialogTitle>
            <DialogDescription>
              {selectedMarketplaceDetail
                ? `可用插件 ${selectedMarketplaceDetail.plugins.length} 个，已安装 ${selectedMarketplaceDetail.installedPlugins.length} 个`
                : "加载中..."}
            </DialogDescription>
          </DialogHeader>

          {selectedMarketplaceDetail ? (
            <div className="space-y-3 px-6 pb-6">
              <Input
                className="bg-muted/30"
                value={marketplaceSearch}
                onChange={(e) => setMarketplaceSearch(e.target.value)}
                placeholder="搜索插件名称或描述"
              />

              <div className="max-h-[56vh] space-y-2 overflow-y-auto pr-1">
                {filteredMarketplacePlugins.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">没有匹配的插件</div>
                ) : (
                  filteredMarketplacePlugins.map((plugin) => {
                    const installed = selectedMarketplaceDetail.installedPlugins.find(
                      (item) => item.pluginName === plugin.name
                    );
                    const pluginKey = `${selectedMarketplaceDetail.marketplace.id}:${plugin.name}`;
                    const installing = installingPluginKey === pluginKey;
                    return (
                      <div
                        key={pluginKey}
                        className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-2 transition-colors hover:bg-muted/30"
                      >
                        <Puzzle size={16} className={installed ? "text-emerald-500" : "text-muted-foreground"} />
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium leading-5">{plugin.name}</p>
                          <p className="break-words whitespace-normal text-xs leading-5 text-muted-foreground">
                            {plugin.description ?? plugin.source ?? "-"}
                          </p>
                        </div>
                        {installed ? (
                          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-500">
                            已安装
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="default"
                            type="button"
                            disabled={installing}
                            onClick={() => { void handleInstallMarketplacePlugin(plugin.name); }}
                          >
                            {installing ? "安装中..." : "安装"}
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {marketplaceActionError ? (
                <p className="text-xs text-destructive">{marketplaceActionError}</p>
              ) : null}

              {selectedMarketplaceDetail.warnings.length > 0 ? (
                <div className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {selectedMarketplaceDetail.warnings.map((warning, index) => (
                    <p key={`${warning.code}-${index}`}>
                      [{warning.code}] {warning.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
