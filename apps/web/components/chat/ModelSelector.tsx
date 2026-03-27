"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, Cpu, Search } from "lucide-react";
import type { Channel, ModelOption } from "@lume/shared";
import { conversationsAtom, currentConversationIdAtom, selectedModelAtom } from "@/atoms/chat-atoms";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { updateConversationModel } from "@/lib/desktop-api/chat";
import { listChannels } from "@/lib/desktop-api/system";
import { getChannelLogo, getModelLogo } from "@/lib/model-logo";
import { cn } from "@/lib/utils";

export function buildModelOptions(channels: Channel[], filterChannelId?: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const channel of channels) {
    if (!channel.enabled) continue;
    if (filterChannelId && channel.id !== filterChannelId) continue;
    const fallbackIds = new Set(channel.fallbackModelIds ?? []);
    const sortedModels = [...channel.models].sort((a, b) => {
      const aDefault = channel.defaultModelId === a.id ? 1 : 0;
      const bDefault = channel.defaultModelId === b.id ? 1 : 0;
      if (aDefault !== bDefault) return bDefault - aDefault;
      const aEnabled = a.enabled ? 1 : 0;
      const bEnabled = b.enabled ? 1 : 0;
      if (aEnabled !== bEnabled) return bEnabled - aEnabled;
      return a.name.localeCompare(b.name);
    });
    for (const model of sortedModels) {
      if (!model.enabled) continue;
      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelRef: model.id.includes("/") ? model.id : `${channel.provider}/${model.id}`,
        modelName: model.name,
        modelAlias: model.alias,
        isDefault: channel.defaultModelId === model.id,
        isFallback: fallbackIds.has(model.id),
        provider: channel.provider
      });
    }
  }
  return options;
}

export function groupModelOptionsByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    const group = groups.get(option.channelId) ?? [];
    group.push(option);
    groups.set(option.channelId, group);
  }
  return groups;
}

export function filterGroupedModelOptions(
  grouped: Map<string, ModelOption[]>,
  search: string
): Map<string, ModelOption[]> {
  if (!search.trim()) {
    return grouped;
  }
  const query = search.toLowerCase();
  const filtered = new Map<string, ModelOption[]>();
  for (const [channelId, options] of grouped.entries()) {
    const matched = options.filter((item) => (
      item.modelName.toLowerCase().includes(query)
      || item.channelName.toLowerCase().includes(query)
      || item.modelId.toLowerCase().includes(query)
      || item.modelRef?.toLowerCase().includes(query)
      || item.modelAlias?.toLowerCase().includes(query)
    ));
    if (matched.length > 0) {
      filtered.set(channelId, matched);
    }
  }
  return filtered;
}

interface ModelSelectorProps {
  filterChannelId?: string;
  externalSelectedModel?: { channelId: string; modelId: string } | null;
  onModelSelect?: (option: ModelOption) => void;
}

export function ModelSelector({
  filterChannelId,
  externalSelectedModel,
  onModelSelect
}: ModelSelectorProps = {}): React.ReactElement {
  const [internalSelectedModel, setInternalSelectedModel] = useAtom(selectedModelAtom);
  const currentConversationId = useAtomValue(currentConversationIdAtom);
  const setConversations = useSetAtom(conversationsAtom);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const itemRefs = useState<Map<number, HTMLButtonElement>>(new Map())[0];
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : internalSelectedModel;

  useEffect(() => {
    void listChannels().then(setChannels);
  }, []);

  useEffect(() => {
    if (!open) return;
    void listChannels().then(setChannels);
    setSearch("");
  }, [open]);

  const modelOptions = useMemo(() => buildModelOptions(channels, filterChannelId), [channels, filterChannelId]);
  const grouped = useMemo(() => groupModelOptionsByChannel(modelOptions), [modelOptions]);
  const filteredGrouped = useMemo(() => filterGroupedModelOptions(grouped, search), [grouped, search]);

  const flatOptions = useMemo(() => {
    const result: ModelOption[] = [];
    for (const options of filteredGrouped.values()) {
      result.push(...options);
    }
    return result;
  }, [filteredGrouped]);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [search]);

  useEffect(() => {
    if (highlightIndex < 0) return;
    itemRefs.get(highlightIndex)?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, itemRefs]);

  const currentModelInfo = useMemo(() => {
    if (!selectedModel) return null;
    return modelOptions.find((item) => (
      item.channelId === selectedModel.channelId
      && item.modelId === selectedModel.modelId
    )) ?? null;
  }, [selectedModel, modelOptions]);

  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option);
      setOpen(false);
      return;
    }

    setInternalSelectedModel({ channelId: option.channelId, modelId: option.modelId });
    setOpen(false);
    if (currentConversationId) {
      void updateConversationModel(currentConversationId, option.modelId, option.channelId).then((updated) => {
        setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      });
    }
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (flatOptions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) => (prev < flatOptions.length - 1 ? prev + 1 : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : flatOptions.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = flatOptions[highlightIndex >= 0 ? highlightIndex : 0];
      if (target) handleSelect(target);
    }
  };

  if (modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        <Cpu className="size-3.5" />
        <span>暂无可用模型</span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-10 max-w-[220px] items-center gap-2 rounded-xl border border-border/70 px-3 text-xs transition-colors",
            "bg-slate-800/80 text-slate-100 hover:bg-slate-800"
          )}
        >
          {currentModelInfo ? (
            <img
              src={getModelLogo(currentModelInfo.modelId, currentModelInfo.provider)}
              alt={currentModelInfo.modelName}
              className="size-4 shrink-0 rounded object-cover"
            />
          ) : (
            <Cpu className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {currentModelInfo
              ? currentModelInfo.modelName
              : "选择模型"}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-slate-300 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[376px] overflow-hidden rounded-2xl border border-slate-700/80 bg-[#1f242d] p-0 text-slate-100 shadow-2xl"
      >
        <div className="border-b border-slate-700/80 px-4 py-3">
          <div className="flex items-center gap-3 rounded-xl border border-slate-700/80 bg-[#242a33] px-3 py-2.5">
            <Search className="size-4 shrink-0 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search models..."
              className="h-5 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-500"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto py-2">
          {filteredGrouped.size === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-400">未找到模型</div>
          ) : (
            (() => {
              let flatIndex = 0;
              return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                const first = options[0];
                if (!first) return null;
                const channel = channels.find((item) => item.id === channelId);
                return (
                  <div key={channelId} className="px-2 pb-2">
                    <div className="flex items-center gap-2 px-2 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
                      <img
                        src={getChannelLogo(channel?.baseUrl ?? "")}
                        alt={first.channelName}
                        className="size-3.5 rounded-sm object-cover opacity-70"
                      />
                      <span className="truncate">{first.channelName}</span>
                    </div>

                    <div className="space-y-1">
                      {options.map((option) => {
                        const isSelected = (
                          selectedModel?.channelId === option.channelId
                          && selectedModel?.modelId === option.modelId
                        );
                        const currentFlatIndex = flatIndex++;
                        const isHighlighted = currentFlatIndex === highlightIndex;
                        return (
                          <button
                            key={`${option.channelId}:${option.modelId}`}
                            ref={(el) => {
                              if (el) itemRefs.set(currentFlatIndex, el);
                              else itemRefs.delete(currentFlatIndex);
                            }}
                            type="button"
                            onClick={() => handleSelect(option)}
                            onMouseEnter={() => setHighlightIndex(currentFlatIndex)}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
                              "border-transparent bg-transparent hover:bg-[#242a33]",
                              isHighlighted && "bg-[#242a33]",
                              isSelected && "border-[#3d5770] bg-[#35506a]"
                            )}
                          >
                            <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-black/10">
                              {isSelected ? (
                                <Check className="size-4 text-white" />
                              ) : (
                                <img
                                  src={getModelLogo(option.modelId, option.provider)}
                                  alt={option.modelName}
                                  className="size-5 rounded object-cover"
                                />
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[15px] font-medium text-slate-100">
                                  {option.modelName}
                                </span>
                                {option.modelAlias ? (
                                  <span className="shrink-0 rounded-md bg-black/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                                    {option.modelAlias}
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                                <span className="truncate">{option.modelRef ?? option.modelId}</span>
                                {option.isDefault ? (
                                  <span className="shrink-0 text-emerald-400">默认</span>
                                ) : null}
                                {!option.isDefault && option.isFallback ? (
                                  <span className="shrink-0 text-amber-400">回退</span>
                                ) : null}
                              </div>
                            </div>

                            <div className="shrink-0 text-[11px] text-slate-500">
                              {option.modelId}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
