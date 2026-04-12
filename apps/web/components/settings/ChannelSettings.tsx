import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  PROVIDER_API_FAMILIES,
  PROVIDER_API_FAMILY_LABELS,
  PROVIDER_LABELS,
  type Channel
} from "@lume/shared";
import { agentChannelIdAtom, agentModelIdAtom } from "@/atoms";
import {
  deleteChannel,
  getEffectiveSystemConfig,
  listChannels,
  updateSystemConfigSection,
  updateChannel
} from "@/lib/desktop-api/system";
import { getChannelLogo } from "@/lib/model-logo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ChannelForm } from "./ChannelForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type ViewMode = "list" | "create" | "edit";

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [embeddingModelRef, setEmbeddingModelRef] = useState<string>("");
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [, setAgentModelId] = useAtom(agentModelIdAtom);
  const embeddingModels = channels
    .filter((channel) => channel.enabled)
    .flatMap((channel) =>
      channel.models
        .filter((model) => model.enabled && model.capabilities?.embedding)
        .map((model) => ({
          channel,
          model,
          modelRef: `${channel.provider}/${model.id}`
        }))
    );
  const loadChannels = async (): Promise<void> => {
    try {
      const [list, systemConfig] = await Promise.all([
        listChannels(),
        getEffectiveSystemConfig()
      ]);
      setChannels(list);
      setEmbeddingModelRef(systemConfig.models?.embedding?.defaultModelRef ?? "");
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

  const handleEmbeddingModelSelect = async (modelRef: string): Promise<void> => {
    setEmbeddingSaving(true);
    try {
      await updateSystemConfigSection("models.embedding.defaultModelRef", modelRef);
      setEmbeddingModelRef(modelRef);
    } catch (error) {
      console.error("[ChannelSettings] update embedding model failed", error);
    } finally {
      setEmbeddingSaving(false);
    }
  };

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
        title="Provider & Model"
        description="统一管理运行渠道、模型目录与策略；Chat 和 Agent 共用同一套配置。"
        action={
          <Button size="sm" type="button" onClick={() => setViewMode("create")}>
            <Plus size={16} />
            <span>添加渠道</span>
          </Button>
        }
      >
        <SettingsCard>
          <div className="px-4 py-3">
            <div className="text-sm font-medium text-foreground">默认 Embedding 模型</div>
            <div className="mt-1 text-xs text-muted-foreground">
              用于记忆向量化与后续非对话 embedding 能力，最终保存为 provider/model。
            </div>
            <div className="mt-3 space-y-2">
              {embeddingModels.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  当前没有可用的 Embedding 模型。请在渠道模型中启用带有 Embedding 能力的模型。
                </div>
              ) : embeddingModels.map(({ channel, model, modelRef }) => (
                <button
                  key={modelRef}
                  type="button"
                  disabled={embeddingSaving}
                  onClick={() => { void handleEmbeddingModelSelect(modelRef); }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    embeddingModelRef === modelRef
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border/60 hover:bg-muted/40"
                  )}
                >
                  <span>{channel.name} · {model.name}</span>
                  <span className="text-xs text-muted-foreground">{modelRef}</span>
                </button>
              ))}
            </div>
          </div>
        </SettingsCard>

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
                selectedForAgent={agentChannelId === channel.id}
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
                onSelectAgentDefault={() => {
                  handleSelectAgentProvider(channel.id);
                }}
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
  selectedForAgent: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onSelectAgentDefault: () => void;
};

function ChannelRow({
  channel,
  selectedForAgent,
  onEdit,
  onDelete,
  onToggle,
  onSelectAgentDefault
}: ChannelRowProps): React.ReactElement {
  const enabledCount = channel.models.filter((model) => model.enabled).length;
  const defaultModel = channel.models.find((model) => model.id === channel.defaultModelId);
  const fallbackCount = (channel.fallbackModelIds ?? []).length;
  const description = [
    `${PROVIDER_LABELS[channel.provider]} (${PROVIDER_API_FAMILY_LABELS[PROVIDER_API_FAMILIES[channel.provider]]})`,
    enabledCount > 0 ? `${enabledCount} 个模型已启用` : undefined,
    defaultModel ? `默认: ${defaultModel.name}` : undefined,
    fallbackCount > 0 ? `回退: ${fallbackCount}` : undefined
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsRow
      label={channel.name}
      icon={<img src={getChannelLogo(channel.baseUrl)} alt="" className="h-8 w-8 rounded-lg object-cover" />}
      description={description}
      className="group"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelectAgentDefault}
          disabled={!channel.enabled}
          className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title="设为默认运行渠道"
        >
          {selectedForAgent ? "运行默认" : "设为运行默认"}
        </button>
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
