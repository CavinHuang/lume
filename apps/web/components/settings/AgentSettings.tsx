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



    </div>
  );
}
