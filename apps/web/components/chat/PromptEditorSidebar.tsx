"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Plus, Star, Trash2, X } from "lucide-react";
import type { SystemPrompt, SystemPromptCreateInput, SystemPromptUpdateInput } from "@lume/shared";
import {
  conversationPromptIdAtom,
  defaultPromptIdAtom,
  promptConfigAtom,
  promptSidebarOpenAtom,
  selectedPromptIdAtom
} from "@/atoms";
import {
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultSystemPrompt,
  updateSystemPrompt,
  updateSystemPromptAppendSetting
} from "@/lib/desktop-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const DEBOUNCE_DELAY_MS = 500;

export function PromptEditorSidebar(): React.ReactElement {
  const [config, setConfig] = useAtom(promptConfigAtom);
  const [selectedId, setSelectedId] = useAtom(selectedPromptIdAtom);
  const defaultPromptId = useAtomValue(defaultPromptIdAtom);
  const setPromptSidebarOpen = useSetAtom(promptSidebarOpenAtom);
  const setConversationPromptMap = useSetAtom(conversationPromptIdAtom);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedPrompt = useMemo(
    () => config.prompts.find((item) => item.id === selectedId),
    [config.prompts, selectedId]
  );

  useEffect(() => {
    void getSystemPromptConfig().then((next) => {
      setConfig(next);
      setSelectedId((prev) => {
        const exists = next.prompts.some((item) => item.id === prev);
        return exists ? prev : (next.defaultPromptId ?? "builtin-default");
      });
    }).catch((error) => {
      console.error("[PromptEditorSidebar] 加载提示词配置失败:", error);
    });
  }, [setConfig, setSelectedId]);

  useEffect(() => {
    if (!selectedPrompt) return;
    setEditName(selectedPrompt.name);
    setEditContent(selectedPrompt.content);
  }, [selectedPrompt]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const debounceSave = (id: string, input: SystemPromptUpdateInput): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void updateSystemPrompt(id, input).then((updated) => {
        setConfig((prev) => ({
          ...prev,
          prompts: prev.prompts.map((item) => (item.id === updated.id ? updated : item))
        }));
      }).catch((error) => {
        console.error("[PromptEditorSidebar] 保存失败:", error);
      });
    }, DEBOUNCE_DELAY_MS);
  };

  const handleCreate = async (): Promise<void> => {
    const input: SystemPromptCreateInput = { name: "新提示词", content: "" };
    try {
      const created = await createSystemPrompt(input);
      setConfig((prev) => ({
        ...prev,
        prompts: [...prev.prompts, created]
      }));
      setSelectedId(created.id);
    } catch (error) {
      console.error("[PromptEditorSidebar] 创建失败:", error);
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await deleteSystemPrompt(id);
      setConfig((prev) => {
        const prompts = prev.prompts.filter((item) => item.id !== id);
        const nextDefault = prev.defaultPromptId === id ? "builtin-default" : prev.defaultPromptId;
        return { ...prev, prompts, defaultPromptId: nextDefault };
      });
      if (selectedId === id) {
        setSelectedId("builtin-default");
      }
      setConversationPromptMap((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [conversationId, promptId] of next.entries()) {
          if (promptId === id) {
            next.set(conversationId, "builtin-default");
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } catch (error) {
      console.error("[PromptEditorSidebar] 删除失败:", error);
    }
  };

  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await setDefaultSystemPrompt(id);
      setConfig((prev) => ({ ...prev, defaultPromptId: id }));
    } catch (error) {
      console.error("[PromptEditorSidebar] 设置默认失败:", error);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">提示词</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { void handleCreate(); }}
            title="新建提示词"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setPromptSidebarOpen(false)}
            title="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="max-h-[200px] shrink-0">
        <div className="py-1">
          {config.prompts.map((prompt) => (
            <SidebarPromptItem
              key={prompt.id}
              prompt={prompt}
              isSelected={prompt.id === selectedId}
              isDefault={prompt.id === defaultPromptId}
              isHovered={hoveredId === prompt.id}
              onSelect={(id) => setSelectedId(id)}
              onDelete={(id) => { void handleDelete(id); }}
              onSetDefault={(id) => { void handleSetDefault(id); }}
              onHoverChange={setHoveredId}
            />
          ))}
        </div>
      </ScrollArea>

      <Separator />

      {selectedPrompt ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">名称</label>
            <Input
              value={editName}
              onChange={(event) => {
                const value = event.target.value;
                setEditName(value);
                if (!selectedPrompt.isBuiltin) {
                  debounceSave(selectedPrompt.id, { name: value });
                }
              }}
              readOnly={selectedPrompt.isBuiltin}
              maxLength={50}
              className={cn("h-8 text-sm", selectedPrompt.isBuiltin && "cursor-not-allowed opacity-60")}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">内容</label>
            <textarea
              value={editContent}
              onChange={(event) => {
                const value = event.target.value;
                setEditContent(value);
                if (!selectedPrompt.isBuiltin) {
                  debounceSave(selectedPrompt.id, { content: value });
                }
              }}
              readOnly={selectedPrompt.isBuiltin}
              placeholder="输入系统提示词内容..."
              className={cn(
                "min-h-[140px] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                selectedPrompt.isBuiltin && "cursor-not-allowed opacity-60"
              )}
            />
          </div>
        </div>
      ) : null}

      <div className="shrink-0 border-t px-3 py-2.5">
        <label className="flex cursor-pointer items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">追加日期时间和用户名</span>
          <Switch
            checked={config.appendDateTimeAndUserName}
            onCheckedChange={(checked) => {
              void updateSystemPromptAppendSetting(checked).then(() => {
                setConfig((prev) => ({ ...prev, appendDateTimeAndUserName: checked }));
              }).catch((error) => {
                console.error("[PromptEditorSidebar] 更新追加设置失败:", error);
              });
            }}
          />
        </label>
      </div>
    </div>
  );
}

interface SidebarPromptItemProps {
  prompt: SystemPrompt;
  isSelected: boolean;
  isDefault: boolean;
  isHovered: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  onHoverChange: (id: string | null) => void;
}

function SidebarPromptItem({
  prompt,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange
}: SidebarPromptItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 transition-colors",
        isSelected ? "bg-accent/50" : "hover:bg-muted/50"
      )}
      onClick={() => onSelect(prompt.id)}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate text-sm">{prompt.name}</span>
        {prompt.isBuiltin ? <span className="shrink-0 text-[10px] text-muted-foreground">(内置)</span> : null}
        {isDefault ? <Star className="size-3 shrink-0 fill-amber-500 text-amber-500" /> : null}
      </div>

      <div className={cn(
        "flex shrink-0 items-center gap-0.5 transition-opacity",
        isHovered ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      >
        {!isDefault ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={(event) => {
              event.stopPropagation();
              onSetDefault(prompt.id);
            }}
            title="设为默认"
          >
            <Star className="size-3 text-muted-foreground" />
          </Button>
        ) : null}
        {!prompt.isBuiltin ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(prompt.id);
            }}
            title="删除"
          >
            <Trash2 className="size-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
