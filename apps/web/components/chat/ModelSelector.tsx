import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, Cpu, Search, Sparkles } from "lucide-react";
import type { Channel, ModelOption } from "@lume/shared";
import { conversationsAtom, currentConversationIdAtom, selectedModelAtom } from "@/atoms/chat-atoms";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { updateConversationModel } from "@/lib/desktop-api/chat";
import { listChannels } from "@/lib/desktop-api/system";
import { getChannelLogo, getModelLogo } from "@/lib/model-logo";
import { cn } from "@/lib/utils";
import {
  buildModelOptions,
  filterGroupedModelOptions,
  groupModelOptionsByChannel,
  resolveModelHighlightIndex,
  resolveModelMetaLabel
} from "./model-selector.helpers";

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
    if (!open) return;
    setHighlightIndex(resolveModelHighlightIndex(flatOptions, selectedModel));
  }, [flatOptions, open, search, selectedModel]);

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
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(
            buttonVariants({ variant: "ghost", size: "default" }),
            "justify-between gap-2 border-none !bg-transparent !px-2.5 !text-xs !h-9 font-medium !text-muted-foreground shadow-none transition-colors",
            "hover:!bg-primary/15 hover:!text-foreground dark:text-foreground dark:hover:!bg-primary/25 dark:hover:text-foreground",
            "max-w-[236px]"
          )}
        >
          {currentModelInfo ? (
            <img
              src={getModelLogo(currentModelInfo.modelId, currentModelInfo.provider)}
              alt={currentModelInfo.modelName}
              className="size-4 shrink-0 object-contain opacity-80"
            />
          ) : (
            <Cpu className="size-4 shrink-0 text-foreground/40" />
          )}
          <span className="hidden max-w-[200px] flex-1 truncate text-left @xl/toolbar:inline">
            {currentModelInfo
              ? currentModelInfo.modelName
              : "选择模型"}
          </span>
          <ChevronDown className="hidden h-3 w-3 shrink-0 opacity-50 @xl/toolbar:inline" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[376px] overflow-hidden rounded-[18px] border border-slate-700/80 bg-[#1f242d] p-0 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="border-b border-slate-700/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))] px-4 py-3">
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

        <div className="max-h-[420px] overflow-y-auto py-1.5">
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
                  <div key={channelId} className="px-1.5 pb-1.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-slate-400">
                      <img
                        src={getChannelLogo(channel?.baseUrl ?? "")}
                        alt={first.channelName}
                        className="size-4 rounded-sm object-cover opacity-70"
                      />
                      <span className="truncate">{first.channelName}</span>
                    </div>

                    <div className="space-y-0.5">
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
                              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                              "border border-transparent bg-transparent hover:bg-[#242a33]",
                              isHighlighted && "bg-[#242a33]",
                              isSelected && "bg-primary/10 dark:bg-primary/20"
                            )}
                          >
                            <div className={cn(
                              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-slate-600 bg-transparent text-transparent"
                            )}>
                              {isSelected ? (
                                <Check className="size-3.5" />
                              ) : (
                                <Check className="size-3.5 opacity-0" />
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-slate-100">
                                  {option.modelName}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center justify-between">
                                <div className="flex items-center gap-2 origin-left scale-[0.75] text-slate-400">
                                  <Sparkles className="size-3 opacity-60" />
                                  <span className="text-[9px] font-medium opacity-60">
                                    {resolveModelMetaLabel(option)}
                                  </span>
                                </div>
                                <span className="font-mono text-[10px] text-slate-500">
                                  {option.modelId}
                                </span>
                              </div>
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
