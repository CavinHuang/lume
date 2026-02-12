"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PROVIDER_LABELS, type Channel } from "@lume/shared";
import { agentChannelIdAtom, agentModelIdAtom } from "@/atoms";
import {
  deleteChannel,
  listChannels,
  updateChannel
} from "@/lib/desktop-api";
import { getChannelLogo } from "@/lib/model-logo";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ChannelForm } from "./ChannelForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type ViewMode = "list" | "create" | "edit";

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [, setAgentModelId] = useAtom(agentModelIdAtom);

  const loadChannels = async (): Promise<void> => {
    try {
      const list = await listChannels();
      setChannels(list);
    } catch (error) {
      console.error("[ChannelSettings] load failed", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadChannels();
  }, []);

  const handleDelete = async (channel: Channel): Promise<void> => {
    if (!window.confirm(`确定删除渠道「${channel.name}」？此操作不可恢复。`)) return;
    try {
      await deleteChannel(channel.id);
      if (agentChannelId === channel.id) {
        setAgentChannelId(null);
        setAgentModelId(null);
      }
      await loadChannels();
    } catch (error) {
      console.error("[ChannelSettings] delete failed", error);
    }
  };

  const handleToggle = async (channel: Channel): Promise<void> => {
    try {
      await updateChannel(channel.id, { enabled: !channel.enabled });
      if (channel.enabled && agentChannelId === channel.id) {
        setAgentChannelId(null);
        setAgentModelId(null);
      }
      await loadChannels();
    } catch (error) {
      console.error("[ChannelSettings] toggle failed", error);
    }
  };

  const handleSelectAgentProvider = (channelId: string): void => {
    setAgentChannelId(channelId);
    setAgentModelId(null);
  };

  const anthropicChannels = useMemo(
    () => channels.filter((channel) => channel.provider === "anthropic" && channel.enabled),
    [channels]
  );

  if (viewMode === "create" || viewMode === "edit") {
    return (
      <ChannelForm
        channel={editingChannel}
        onSaved={() => {
          setViewMode("list");
          setEditingChannel(null);
          void loadChannels();
        }}
        onCancel={() => {
          setViewMode("list");
          setEditingChannel(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="聊天渠道供应商"
        description="管理 AI 对话的供应商连接，配置 API Key 和可用模型"
        action={
          <Button size="sm" type="button" onClick={() => setViewMode("create")}>
            <Plus size={16} />
            <span>添加渠道</span>
          </Button>
        }
      >
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : channels.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="py-12 text-center text-sm text-muted-foreground">
              还没有配置任何渠道，点击上方"添加渠道"开始
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                onEdit={() => {
                  setEditingChannel(channel);
                  setViewMode("edit");
                }}
                onDelete={() => {
                  void handleDelete(channel);
                }}
                onToggle={() => {
                  void handleToggle(channel);
                }}
              />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection
        title="Agent 供应商"
        description="选择一个 Anthropic 兼容格式的渠道作为 Agent 模式的默认供应商"
      >
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : anthropicChannels.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无可用的 Anthropic 兼容格式渠道，请先在上方添加 Anthropic 渠道并启用
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {anthropicChannels.map((channel) => (
              <AgentProviderRow
                key={channel.id}
                channel={channel}
                selected={agentChannelId === channel.id}
                onSelect={() => handleSelectAgentProvider(channel.id)}
              />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  );
}

type ChannelRowProps = {
  channel: Channel;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
};

function ChannelRow({ channel, onEdit, onDelete, onToggle }: ChannelRowProps): React.ReactElement {
  const enabledCount = channel.models.filter((model) => model.enabled).length;
  const description = [
    PROVIDER_LABELS[channel.provider],
    enabledCount > 0 ? `${enabledCount} 个模型已启用` : undefined
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsRow
      label={channel.name}
      icon={<img src={getChannelLogo(channel.baseUrl)} alt="" className="h-8 w-8 rounded" />}
      description={description}
      className="group"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-muted/50 hover:text-foreground"
          title="编辑"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
          title="删除"
        >
          <Trash2 size={14} />
        </button>
        <Switch checked={channel.enabled} onCheckedChange={onToggle} />
      </div>
    </SettingsRow>
  );
}

type AgentProviderRowProps = {
  channel: Channel;
  selected: boolean;
  onSelect: () => void;
};

function AgentProviderRow({ channel, selected, onSelect }: AgentProviderRowProps): React.ReactElement {
  const enabledCount = channel.models.filter((model) => model.enabled).length;
  const description = [
    PROVIDER_LABELS[channel.provider],
    enabledCount > 0 ? `${enabledCount} 个模型可用` : undefined
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsRow
      label={channel.name}
      icon={<img src={getChannelLogo(channel.baseUrl)} alt="" className="h-8 w-8 rounded" />}
      description={description}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
        style={{
          borderColor: selected ? "hsl(var(--primary))" : "hsl(var(--border))"
        }}
      >
        {selected ? (
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "hsl(var(--primary))" }} />
        ) : null}
      </button>
    </SettingsRow>
  );
}
