"use client";

import type { Channel, ChannelModel } from "@lume/shared";

type ModelSelectorProps = {
  channels: Channel[];
  channelId?: string;
  modelId?: string;
  onChange: (channelId: string, modelId: string) => void;
};

export function ModelSelector({
  channels,
  channelId,
  modelId,
  onChange
}: ModelSelectorProps): React.ReactElement {
  const currentChannel = channels.find((item) => item.id === channelId) ?? channels[0];
  const models: ChannelModel[] = currentChannel?.models ?? [];

  return (
    <div className="flex gap-1.5">
      <select
        className="h-9 min-w-[180px] rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 outline-none focus:border-cyan-400"
        value={currentChannel?.id ?? ""}
        onChange={(event) => {
          const nextChannel = channels.find((item) => item.id === event.target.value);
          if (!nextChannel) return;
          const nextModel = nextChannel.models.find((m) => m.enabled) ?? nextChannel.models[0];
          if (!nextModel) return;
          onChange(nextChannel.id, nextModel.id);
        }}
      >
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}
          </option>
        ))}
      </select>
      <select
        className="h-9 min-w-[180px] rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 outline-none focus:border-cyan-400"
        value={modelId ?? ""}
        onChange={(event) => {
          if (!currentChannel) return;
          onChange(currentChannel.id, event.target.value);
        }}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
}
