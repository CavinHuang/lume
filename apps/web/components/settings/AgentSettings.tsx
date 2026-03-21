"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, MessageSquare, Pencil, Plug, Plus, Sparkles, Trash2 } from "lucide-react";
import type {
  AutomationJob,
  AutomationRun,
  ChannelDeliveryRecord,
  ChannelGatewayIngressStatus,
  ChannelProvider,
  ChannelSessionBinding,
  FeishuGatewayConfigView,
  McpServerEntry,
  SkillMeta,
  WorkspaceMcpConfig
} from "@lume/shared";
import {
  activeViewAtom,
  agentChannelIdAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  appModeAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom
} from "@/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  createAutomationJob,
  createAgentSession,
  deleteAutomationJob,
  getFeishuGatewayConfig,
  getChannelGatewayIngressStatus,
  listChannelGatewayBindings,
  listChannelGatewayDeliveries,
  listAutomationJobs,
  getBrowserExtensionInfo,
  getBrowserRelayStatus,
  deleteAgentWorkspaceSkill,
  getAgentWorkspaceMcpConfig,
  listAgentSessions,
  listAgentWorkspaceSkills,
  openExternalUrl,
  saveAgentWorkspaceMcpConfig,
  readAgentBootstrapFile,
  installBrowserExtension,
  listAutomationRuns,
  saveFeishuGatewayConfig,
  simulateChannelGatewayIngress,
  startChannelGatewayIngress,
  startBrowserRelay,
  stopChannelGatewayIngress,
  testFeishuGatewayConfig,
  runAutomationJobNow,
  updateAutomationJob
} from "@/lib/desktop-api";
import { McpServerForm } from "./McpServerForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";
import { MemoryBrowser } from "@/components/memory/MemoryBrowser";

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

const CHANNEL_PROVIDER_OPTIONS: ChannelProvider[] = ["feishu", "telegram", "discord", "whatsapp", "slack"];

export function AgentSettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const agentChannelId = useAtomValue(agentChannelIdAtom);
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
  const [identityContent, setIdentityContent] = useState<Record<string, string>>({});
  const [browserInfo, setBrowserInfo] = useState<Awaited<ReturnType<typeof getBrowserExtensionInfo>> | null>(null);
  const [relayStatus, setRelayStatus] = useState<Awaited<ReturnType<typeof getBrowserRelayStatus>> | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserMessage, setBrowserMessage] = useState("");
  const [automationJobs, setAutomationJobs] = useState<AutomationJob[]>([]);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationCronExpr, setAutomationCronExpr] = useState("30 8 * * 1-5");
  const [automationPrompt, setAutomationPrompt] = useState("");
  const [automationMessage, setAutomationMessage] = useState("");
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [channelGatewayBindings, setChannelGatewayBindings] = useState<ChannelSessionBinding[]>([]);
  const [channelGatewayDeliveries, setChannelGatewayDeliveries] = useState<ChannelDeliveryRecord[]>([]);
  const [channelGatewayLoading, setChannelGatewayLoading] = useState(false);
  const [channelGatewayBusy, setChannelGatewayBusy] = useState(false);
  const [channelGatewayMessage, setChannelGatewayMessage] = useState("");
  const [channelGatewayProvider, setChannelGatewayProvider] = useState<ChannelProvider>("feishu");
  const [channelGatewayExternalChatId, setChannelGatewayExternalChatId] = useState("");
  const [channelGatewayExternalUserId, setChannelGatewayExternalUserId] = useState("");
  const [channelGatewayInboundText, setChannelGatewayInboundText] = useState("");
  const [channelGatewayIngressStatus, setChannelGatewayIngressStatus] = useState<ChannelGatewayIngressStatus | null>(null);
  const [feishuConfig, setFeishuConfig] = useState<FeishuGatewayConfigView | null>(null);
  const [feishuEnabled, setFeishuEnabled] = useState(false);
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [feishuVerificationToken, setFeishuVerificationToken] = useState("");
  const [feishuEncryptKey, setFeishuEncryptKey] = useState("");
  const [feishuDomain, setFeishuDomain] = useState<"feishu" | "lark">("feishu");
  const [feishuWebhookPath, setFeishuWebhookPath] = useState("/webhook/feishu");
  const [feishuDefaultWorkspaceId, setFeishuDefaultWorkspaceId] = useState("");

  const loadData = async (): Promise<void> => {
    if (!workspaceSlug) {
      setLoading(false);
      return;
    }
    try {
      const [config, skillList] = await Promise.all([
        getAgentWorkspaceMcpConfig(workspaceSlug),
        listAgentWorkspaceSkills(workspaceSlug)
      ]);
      setMcpConfig(config);
      setSkills(skillList);
    } catch (error) {
      console.error("[AgentSettings] load workspace data failed", error);
    } finally {
      setLoading(false);
    }
  };

  const refreshBrowserBridge = async (): Promise<void> => {
    try {
      const [info, relay] = await Promise.all([
        getBrowserExtensionInfo(),
        getBrowserRelayStatus()
      ]);
      setBrowserInfo(info);
      setRelayStatus(relay);
    } catch (error) {
      console.error("[AgentSettings] load browser bridge failed", error);
    }
  };

  const loadAutomationData = async (): Promise<void> => {
    setAutomationLoading(true);
    try {
      const [jobs, runs] = await Promise.all([
        listAutomationJobs(),
        listAutomationRuns({ limit: 20 })
      ]);
      setAutomationJobs(jobs);
      setAutomationRuns(runs);
    } catch (error) {
      console.error("[AgentSettings] load automation jobs failed", error);
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationLoading(false);
    }
  };

  const loadChannelGatewayData = async (): Promise<void> => {
    setChannelGatewayLoading(true);
    try {
      const [bindings, deliveries] = await Promise.all([
        listChannelGatewayBindings(),
        listChannelGatewayDeliveries({ limit: 20 })
      ]);
      setChannelGatewayBindings(bindings);
      setChannelGatewayDeliveries(deliveries);
      const [ingressStatus, config] = await Promise.all([
        getChannelGatewayIngressStatus(),
        getFeishuGatewayConfig()
      ]);
      setChannelGatewayIngressStatus(ingressStatus);
      setFeishuConfig(config);
      setFeishuEnabled(config.enabled);
      setFeishuAppId(config.appId);
      setFeishuDomain(config.domain);
      setFeishuWebhookPath(config.webhookPath);
      setFeishuDefaultWorkspaceId(config.defaultWorkspaceId ?? "");
    } catch (error) {
      console.error("[AgentSettings] load channel gateway data failed", error);
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [workspaceSlug, capabilitiesVersion]);

  useEffect(() => {
    void refreshBrowserBridge();
  }, []);

  useEffect(() => {
    void loadAutomationData();
  }, [workspaceSlug]);

  useEffect(() => {
    void loadChannelGatewayData();
  }, []);

  useEffect(() => {
    if (!workspaceSlug) return;
    let cancelled = false;
    void (async () => {
      const results: Record<string, string> = {};
      for (const fileType of ["SOUL", "IDENTITY", "USER"] as const) {
        try {
          const { content } = await readAgentBootstrapFile(workspaceSlug, fileType);
          if (!cancelled && content.trim()) results[fileType] = content;
        } catch { /* ignore */ }
      }
      if (!cancelled) setIdentityContent(results);
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug]);

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
        channelId: agentChannelId ?? undefined,
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

  const handleInstallBrowserExtension = async (): Promise<void> => {
    setBrowserBusy(true);
    setBrowserMessage("");
    try {
      const result = await installBrowserExtension();
      setBrowserMessage(`扩展已安装: ${result.path}`);
      await refreshBrowserBridge();
    } catch (error) {
      setBrowserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserBusy(false);
    }
  };

  const handleStartRelay = async (): Promise<void> => {
    setBrowserBusy(true);
    setBrowserMessage("");
    try {
      await startBrowserRelay();
      setBrowserMessage("Relay 已启动");
      await refreshBrowserBridge();
    } catch (error) {
      setBrowserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserBusy(false);
    }
  };

  const handleCreateAutomationJob = async (): Promise<void> => {
    if (!automationName.trim() || !automationCronExpr.trim() || !automationPrompt.trim()) {
      setAutomationMessage("任务名称、Cron 表达式和提示词不能为空");
      return;
    }
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await createAutomationJob({
        name: automationName.trim(),
        workspaceId: currentWorkspaceId ?? undefined,
        schedule: {
          type: "cron",
          cronExpr: automationCronExpr.trim()
        },
        prompt: automationPrompt.trim()
      });
      setAutomationName("");
      setAutomationPrompt("");
      setAutomationMessage("任务创建成功");
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleToggleAutomationJob = async (job: AutomationJob): Promise<void> => {
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await updateAutomationJob({
        id: job.id,
        enabled: !job.enabled
      });
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleDeleteAutomationJob = async (job: AutomationJob): Promise<void> => {
    if (!window.confirm(`确定删除任务「${job.name}」？此操作不可恢复。`)) return;
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await deleteAutomationJob(job.id);
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleRunAutomationJobNow = async (job: AutomationJob): Promise<void> => {
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      const run = await runAutomationJobNow(job.id);
      setAutomationMessage(`任务已触发: ${run.status}`);
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleSimulateChannelGatewayIngress = async (): Promise<void> => {
    if (!channelGatewayExternalChatId.trim() || !channelGatewayInboundText.trim()) {
      setChannelGatewayMessage("渠道会话ID和入站文本不能为空");
      return;
    }
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const now = Date.now();
      const result = await simulateChannelGatewayIngress({
        event: {
          id: `sim-event-${crypto.randomUUID()}`,
          provider: channelGatewayProvider,
          externalChatId: channelGatewayExternalChatId.trim(),
          externalUserId: channelGatewayExternalUserId.trim() || undefined,
          externalMessageId: `sim-msg-${now}`,
          text: channelGatewayInboundText.trim(),
          receivedAt: now,
          workspaceId: currentWorkspaceId ?? undefined
        }
      });
      if (result.duplicate) {
        setChannelGatewayMessage("已忽略重复消息");
      } else if (result.accepted) {
        setChannelGatewayMessage(`模拟入站成功，session: ${result.binding?.sessionId ?? "unknown"}`);
      } else {
        setChannelGatewayMessage(`模拟入站失败: ${result.error ?? "unknown error"}`);
      }
      await loadChannelGatewayData();
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleStartChannelGatewayIngress = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const status = await startChannelGatewayIngress();
      setChannelGatewayIngressStatus(status);
      setChannelGatewayMessage(`飞书 Webhook 服务已启动: ${status.webhookUrl ?? "unknown"}`);
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleStopChannelGatewayIngress = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      await stopChannelGatewayIngress();
      const status = await getChannelGatewayIngressStatus();
      setChannelGatewayIngressStatus(status);
      setChannelGatewayMessage("飞书 Webhook 服务已停止");
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleSaveFeishuConfig = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const saved = await saveFeishuGatewayConfig({
        enabled: feishuEnabled,
        appId: feishuAppId.trim(),
        ...(feishuAppSecret.trim() ? { appSecret: feishuAppSecret.trim() } : {}),
        ...(feishuVerificationToken.trim() ? { verificationToken: feishuVerificationToken.trim() } : {}),
        ...(feishuEncryptKey.trim() ? { encryptKey: feishuEncryptKey.trim() } : {}),
        domain: feishuDomain,
        defaultWorkspaceId: feishuDefaultWorkspaceId.trim() || undefined,
        webhookPath: feishuWebhookPath.trim()
      });
      setFeishuConfig(saved);
      setFeishuAppSecret("");
      setFeishuVerificationToken("");
      setFeishuEncryptKey("");
      setChannelGatewayMessage("飞书配置已保存");
      await loadChannelGatewayData();
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleTestFeishuConfig = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const result = await testFeishuGatewayConfig();
      setChannelGatewayMessage(
        result.success
          ? `连通成功: ${result.message}${result.botOpenId ? ` · bot=${result.botOpenId}` : ""}`
          : `连通失败: ${result.message}`
      );
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
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
  const workspaceAutomationJobs = automationJobs.filter(
    (job) => !job.workspaceId || job.workspaceId === currentWorkspaceId
  );
  const workspaceAutomationRuns = automationRuns.filter((run) =>
    workspaceAutomationJobs.some((job) => job.id === run.jobId)
  );

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

      <SettingsSection title="Chrome Extension 模式" description="对齐 OpenClaw：先启动 relay，再在 Chrome 扩展里附加标签页">
        <SettingsCard divided={false}>
          <div className="space-y-3 p-3 text-sm">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">Relay 状态</p>
              <p className="mt-1 text-muted-foreground">
                运行: {relayStatus?.running ? "是" : "否"} · 扩展连接: {relayStatus?.connected ? "已连接" : "未连接"} · 连接数: {relayStatus?.connectionCount ?? 0} · 已附加标签页: {relayStatus?.tabs.length ?? 0}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                端口: {relayStatus?.port ?? browserInfo?.relay.port ?? "-"} · URL: {browserInfo?.relay.httpUrl ?? "http://127.0.0.1:18792/"}
              </p>
              {(relayStatus?.diagnostics?.lastRejectReason || relayStatus?.diagnostics?.lastCloseReason) ? (
                <p className="mt-1 text-xs text-amber-700">
                  诊断: {relayStatus?.diagnostics?.lastRejectReason || "无拒绝"} · {relayStatus?.diagnostics?.lastCloseReason || "无断开"}
                </p>
              ) : null}
              {(relayStatus?.tokenRequired || browserInfo?.relay.tokenRequired) ? (
                <p className="mt-1 text-xs text-amber-600">
                  当前 Relay 已启用 token 鉴权，请在扩展 Options 中填写与 `LUME_BROWSER_RELAY_TOKEN` 相同的值。
                </p>
              ) : null}
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">扩展安装</p>
              <p className="mt-1 text-muted-foreground">
                已安装: {browserInfo?.installed ? "是" : "否"}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                路径: {browserInfo?.installedPath ?? "~/.lume/browser/chrome-extension"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" type="button" disabled={browserBusy} onClick={() => { void handleInstallBrowserExtension(); }}>
                安装扩展到稳定目录
              </Button>
              <Button size="sm" type="button" variant="secondary" disabled={browserBusy} onClick={() => { void handleStartRelay(); }}>
                启动 Relay
              </Button>
              <Button size="sm" type="button" variant="outline" onClick={() => { void openExternalUrl("chrome://extensions/"); }}>
                打开 chrome://extensions
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => { void refreshBrowserBridge(); }}>
                刷新状态
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              操作顺序: 1) 安装扩展 2) 启动 Relay 3) Chrome 开启 Developer mode 并 Load unpacked 指向上方路径 4) 点击扩展图标附加当前标签页。
            </p>
            {browserMessage ? <p className="text-xs text-foreground">{browserMessage}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="自动化任务（MVP）" description="当前先支持 Cron 任务创建、启停与删除">
        <SettingsCard divided={false}>
          <div className="space-y-3 p-3 text-sm">
            <div className="grid gap-2">
              <Input
                value={automationName}
                onChange={(event) => setAutomationName(event.target.value)}
                placeholder="任务名称，例如：工作日早报准备"
              />
              <Input
                value={automationCronExpr}
                onChange={(event) => setAutomationCronExpr(event.target.value)}
                placeholder="Cron 表达式，例如：30 8 * * 1-5"
              />
              <textarea
                value={automationPrompt}
                onChange={(event) => setAutomationPrompt(event.target.value)}
                placeholder="执行提示词，例如：汇总昨天工作区代码变更并生成早报"
                rows={4}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex justify-end">
                <Button size="sm" type="button" disabled={automationBusy} onClick={() => { void handleCreateAutomationJob(); }}>
                  创建任务
                </Button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">任务列表（当前工作区）</p>
              {automationLoading ? (
                <p className="mt-2 text-muted-foreground">加载中...</p>
              ) : workspaceAutomationJobs.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无任务</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {workspaceAutomationJobs.map((job) => (
                    <div key={job.id} className="rounded-md border bg-background/80 p-2">
                      <p className="font-medium">{job.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Cron: {job.schedule.cronExpr ?? "-"} · 更新时间: {new Date(job.updatedAt).toLocaleString()}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Switch checked={job.enabled} onCheckedChange={() => { void handleToggleAutomationJob(job); }} />
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => { void handleRunAutomationJobNow(job); }}
                        >
                          立即执行
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => { void handleDeleteAutomationJob(job); }}
                        >
                          <Trash2 size={14} />
                          <span>删除</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">最近运行记录</p>
              {workspaceAutomationRuns.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无记录</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {workspaceAutomationRuns.slice(0, 8).map((run) => (
                    <div key={run.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">
                        {run.jobName} · {run.status}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        触发: {run.trigger} · {new Date(run.startedAt).toLocaleString()}
                      </p>
                      {run.sessionId ? (
                        <p className="text-xs text-muted-foreground">会话: {run.sessionId}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">{run.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {automationMessage ? <p className="text-xs text-foreground">{automationMessage}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="外部渠道网关（MVP）" description="绑定外部会话到 Agent Session，并支持模拟入站验证链路">
        <SettingsCard divided={false}>
          <div className="space-y-3 p-3 text-sm">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">飞书凭证配置</p>
              <div className="mt-2 grid gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={feishuEnabled} onCheckedChange={setFeishuEnabled} />
                  启用飞书网关
                </label>
                <Input
                  value={feishuAppId}
                  onChange={(event) => setFeishuAppId(event.target.value)}
                  placeholder="App ID，例如: cli_xxx"
                />
                <Input
                  value={feishuAppSecret}
                  onChange={(event) => setFeishuAppSecret(event.target.value)}
                  placeholder={feishuConfig?.hasAppSecret ? "App Secret（留空表示保持不变）" : "App Secret"}
                  type="password"
                />
                <Input
                  value={feishuVerificationToken}
                  onChange={(event) => setFeishuVerificationToken(event.target.value)}
                  placeholder={feishuConfig?.hasVerificationToken ? "Verification Token（留空表示保持不变）" : "Verification Token"}
                  type="password"
                />
                <Input
                  value={feishuEncryptKey}
                  onChange={(event) => setFeishuEncryptKey(event.target.value)}
                  placeholder={feishuConfig?.hasEncryptKey ? "Encrypt Key（留空表示保持不变）" : "Encrypt Key（可选）"}
                  type="password"
                />
                <select
                  value={feishuDomain}
                  onChange={(event) => setFeishuDomain(event.target.value as "feishu" | "lark")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="feishu">feishu</option>
                  <option value="lark">lark</option>
                </select>
                <Input
                  value={feishuWebhookPath}
                  onChange={(event) => setFeishuWebhookPath(event.target.value)}
                  placeholder="Webhook Path，例如 /webhook/feishu"
                />
                <Input
                  value={feishuDefaultWorkspaceId}
                  onChange={(event) => setFeishuDefaultWorkspaceId(event.target.value)}
                  placeholder="默认绑定 workspaceId（可选）"
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" type="button" variant="outline" disabled={channelGatewayBusy} onClick={() => { void handleTestFeishuConfig(); }}>
                    测试连接
                  </Button>
                  <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleSaveFeishuConfig(); }}>
                    保存飞书配置
                  </Button>
                </div>
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">飞书 Webhook 接入状态</p>
              <p className="mt-1 text-muted-foreground">
                运行: {channelGatewayIngressStatus?.running ? "是" : "否"} · 端口: {channelGatewayIngressStatus?.port ?? "-"}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                URL: {channelGatewayIngressStatus?.webhookUrl ?? "未启动"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleStartChannelGatewayIngress(); }}>
                  启动飞书 Webhook 服务
                </Button>
                <Button size="sm" type="button" variant="secondary" disabled={channelGatewayBusy} onClick={() => { void handleStopChannelGatewayIngress(); }}>
                  停止服务
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                飞书事件订阅地址填写上方 URL，事件选择 `im.message.receive_v1`。本地调试请配合内网穿透工具暴露到公网 HTTPS。
              </p>
            </div>
            <div className="grid gap-2">
              <select
                value={channelGatewayProvider}
                onChange={(event) => setChannelGatewayProvider(event.target.value as ChannelProvider)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {CHANNEL_PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider} value={provider}>{provider}</option>
                ))}
              </select>
              <Input
                value={channelGatewayExternalChatId}
                onChange={(event) => setChannelGatewayExternalChatId(event.target.value)}
                placeholder="外部会话ID，例如: tg_chat_123"
              />
              <Input
                value={channelGatewayExternalUserId}
                onChange={(event) => setChannelGatewayExternalUserId(event.target.value)}
                placeholder="外部用户ID（可选）"
              />
              <textarea
                value={channelGatewayInboundText}
                onChange={(event) => setChannelGatewayInboundText(event.target.value)}
                placeholder="模拟入站文本，例如：请总结今天工作进度"
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" type="button" variant="outline" disabled={channelGatewayBusy} onClick={() => { void loadChannelGatewayData(); }}>
                  刷新
                </Button>
                <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleSimulateChannelGatewayIngress(); }}>
                  模拟入站
                </Button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">会话绑定</p>
              {channelGatewayLoading ? (
                <p className="mt-2 text-muted-foreground">加载中...</p>
              ) : channelGatewayBindings.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无绑定</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {channelGatewayBindings.slice(0, 8).map((binding) => (
                    <div key={binding.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">
                        {binding.provider} · {binding.externalChatId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        session: {binding.sessionId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        更新时间: {new Date(binding.updatedAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">最近投递记录</p>
              {channelGatewayLoading ? (
                <p className="mt-2 text-muted-foreground">加载中...</p>
              ) : channelGatewayDeliveries.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无记录</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {channelGatewayDeliveries.slice(0, 8).map((delivery) => (
                    <div key={delivery.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">
                        {delivery.provider} · {delivery.status}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        outbound: {delivery.outboundMessageId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        attempts: {delivery.attempts} · {new Date(delivery.updatedAt).toLocaleString()}
                      </p>
                      {delivery.error ? <p className="mt-1 text-xs text-amber-700">{delivery.error}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {channelGatewayMessage ? <p className="text-xs text-foreground">{channelGatewayMessage}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>

      {Object.keys(identityContent).length > 0 && (
        <SettingsSection title="Identity" description="工作区身份与人格文件（只读）">
          <SettingsCard divided={false}>
            <div className="space-y-3 p-3">
              {(["SOUL", "IDENTITY", "USER"] as const).map((key) =>
                identityContent[key] ? (
                  <div key={key}>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{key}.md</div>
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs text-foreground/80">{identityContent[key]}</pre>
                  </div>
                ) : null
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {workspaceSlug && (
        <SettingsSection title="记忆浏览器" description="搜索工作区记忆内容">
          <SettingsCard divided={false}>
            <div className="p-3">
              <MemoryBrowser workspaceSlug={workspaceSlug} />
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

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
        <Button size="sm" className="w-full" type="button" onClick={() => { void handleConfigViaChat(buildSkillPrompt()); }}>
          <MessageSquare size={14} />
          <span>跟 Lume Agent 对话完成配置</span>
        </Button>
      </SettingsSection>

    </div>
  );
}
