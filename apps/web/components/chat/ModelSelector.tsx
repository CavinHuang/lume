"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, Cpu, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getChannelLogo, getModelLogo } from "@/lib/model-logo";
import { conversationsAtom, currentConversationIdAtom, selectedModelAtom } from "@/atoms/chat-atoms";
import { listChannels, updateConversationModel } from "@/lib/desktop-api";
import type { Channel, ModelOption } from "@lume/shared";

function buildModelOptions(channels: Channel[], filterChannelId?: string): ModelOption[] {
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

function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    const group = groups.get(option.channelId) ?? [];
    group.push(option);
    groups.set(option.channelId, group);
  }
  return groups;
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
  const grouped = useMemo(() => groupByChannel(modelOptions), [modelOptions]);

  const filteredGrouped = useMemo(() => {
    if (!search.trim()) return grouped;
    const query = search.toLowerCase();
    const filtered = new Map<string, ModelOption[]>();
    for (const [channelId, options] of grouped.entries()) {
      const matched = options.filter(
        (item) =>
          item.modelName.toLowerCase().includes(query) ||
          item.channelName.toLowerCase().includes(query) ||
          item.modelId.toLowerCase().includes(query) ||
          item.modelRef?.toLowerCase().includes(query) ||
          item.modelAlias?.toLowerCase().includes(query)
      );
      if (matched.length) filtered.set(channelId, matched);
    }
    return filtered;
  }, [grouped, search]);

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
    return modelOptions.find(
      (item) =>
        item.channelId === selectedModel.channelId &&
        item.modelId === selectedModel.modelId
    ) ?? null;
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground"
      >
        {currentModelInfo ? (
          <img
            src={getModelLogo(currentModelInfo.modelId, currentModelInfo.provider)}
            alt={currentModelInfo.modelName}
            className="size-4 rounded object-cover"
          />
        ) : (
          <Cpu className="size-3.5" />
        )}
        <span className="max-w-[200px] truncate">
          {currentModelInfo
            ? `${currentModelInfo.modelName}${currentModelInfo.modelAlias ? ` #${currentModelInfo.modelAlias}` : ""}`
            : "选择模型"}
        </span>
        <ChevronDown className="size-3" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg gap-0 p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>选择模型</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
            <Search className="size-5 shrink-0 text-muted-foreground/60" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索模型..."
              className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {filteredGrouped.size === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">未找到模型</div>
            ) : (
              (() => {
                let flatIndex = 0;
                return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                const first = options[0];
                if (!first) return null;
                return (
                  <div key={channelId}>
                    <div className="flex items-center gap-2 border-b border-border/30 bg-muted/50 px-4 py-2">
                      <img
                        src={getChannelLogo(channels.find((item) => item.id === channelId)?.baseUrl ?? "")}
                        alt={first.channelName}
                        className="size-5 rounded object-cover"
                      />
                      <span className="text-sm font-medium text-muted-foreground">{first.channelName}</span>
                    </div>
                    {options.map((option) => {
                      const isSelected =
                        selectedModel?.channelId === option.channelId &&
                        selectedModel?.modelId === option.modelId;
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
                            "mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-4 py-1.5 text-left transition-colors duration-100 hover:bg-accent",
                            isHighlighted && "bg-accent",
                            isSelected && "border-l-2 border-l-primary bg-accent/30"
                          )}
                        >
                          <img
                            src={getModelLogo(option.modelId, option.provider)}
                            alt={option.modelName}
                            className="size-5 shrink-0 rounded object-cover"
                          />
                          <span className="min-w-0 flex-1">
                            <span className={cn("block truncate text-sm", isSelected ? "font-medium text-foreground" : "text-foreground/80")}>
                              {option.modelName}
                              {option.modelAlias ? <span className="ml-1 text-xs text-muted-foreground">#{option.modelAlias}</span> : null}
                              {option.isDefault ? <span className="ml-1 text-xs text-emerald-600">默认</span> : null}
                              {!option.isDefault && option.isFallback ? <span className="ml-1 text-xs text-amber-600">回退</span> : null}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground/80">
                              {option.modelRef ?? option.modelId}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              });
              })()
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
