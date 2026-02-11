"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Channel } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { deleteChannel, listChannels, updateChannel } from "@/lib/desktop-api";
import { ChannelForm } from "./ChannelForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type ViewMode = "list" | "create" | "edit";

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  const loadChannels = async (): Promise<void> => {
    setLoading(true);
    try {
      setChannels(await listChannels());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadChannels();
  }, []);

  if (viewMode !== "list") {
    return (
      <ChannelForm
        channel={viewMode === "edit" ? editingChannel : null}
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
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="聊天渠道供应商"
        description="管理 AI 对话的供应商连接，配置 API Key 和模型列表"
        action={
          <Button type="button" onClick={() => setViewMode("create")}>
            <Plus size={14} />
            添加渠道
          </Button>
        }
      >
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : channels.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground">还没有配置任何渠道，点击上方“添加渠道”开始。</div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {channels.map((channel) => (
              <SettingsRow
                key={channel.id}
                label={channel.name}
                description={`${channel.provider} · ${channel.models.filter((m) => m.enabled).length} 个模型已启用`}
              >
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-300 hover:bg-slate-800"
                    onClick={() => {
                      setEditingChannel(channel);
                      setViewMode("edit");
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-900 bg-red-950/30 px-2 py-1 text-red-300 hover:bg-red-900/40"
                    onClick={async () => {
                      if (!window.confirm(`确定删除渠道「${channel.name}」？`)) return;
                      await deleteChannel(channel.id);
                      await loadChannels();
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                  <Switch
                    checked={channel.enabled}
                    onCheckedChange={async (checked) => {
                      await updateChannel(channel.id, { enabled: checked });
                      await loadChannels();
                    }}
                  />
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  );
}
