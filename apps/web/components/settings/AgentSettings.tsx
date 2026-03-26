"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, MessageSquare, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import type {
  McpServerEntry,
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
import { Switch } from "@/components/ui/switch";
import {
  createAgentSession,
  getAgentWorkspaceMcpConfig,
  listAgentSessions,
  saveAgentWorkspaceMcpConfig
} from "@/lib/desktop-api/agent";
import { openExternalUrl } from "@/lib/desktop-api/core";
import {
  getBrowserExtensionInfo,
  getBrowserRelayStatus,
  installBrowserExtension,
  startBrowserRelay
} from "@/lib/desktop-api/system";
import { McpServerForm } from "./McpServerForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

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
  const [loading, setLoading] = useState(true);
  const [browserInfo, setBrowserInfo] = useState<Awaited<ReturnType<typeof getBrowserExtensionInfo>> | null>(null);
  const [relayStatus, setRelayStatus] = useState<Awaited<ReturnType<typeof getBrowserRelayStatus>> | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserMessage, setBrowserMessage] = useState("");

  const loadData = async (): Promise<void> => {
    if (!workspaceSlug) {
      setLoading(false);
      return;
    }
    try {
      const config = await getAgentWorkspaceMcpConfig(workspaceSlug);
      setMcpConfig(config);
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

  useEffect(() => {
    void loadData();
  }, [workspaceSlug, capabilitiesVersion]);

  useEffect(() => {
    void refreshBrowserBridge();
  }, []);

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

    </div>
  );
}
