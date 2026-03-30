import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Plus, Star, Trash2 } from "lucide-react";
import type {
  SystemPrompt,
  SystemPromptCreateInput,
  SystemPromptUpdateInput
} from "@lume/shared";
import { conversationPromptIdAtom, defaultPromptIdAtom, promptConfigAtom, selectedPromptIdAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultSystemPrompt,
  updateSystemPrompt,
  updateSystemPromptAppendSetting
} from "@/lib/desktop-api/chat";
import { SettingsCard, SettingsSection, SettingsToggle } from "./primitives";

const DEBOUNCE_DELAY_MS = 500;

export function PromptSettings(): React.ReactElement {
  const [config, setConfig] = useAtom(promptConfigAtom);
  const [selectedId, setSelectedId] = useAtom(selectedPromptIdAtom);
  const defaultPromptId = useAtomValue(defaultPromptIdAtom);
  const setConversationPromptMap = useSetAtom(conversationPromptIdAtom);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedPrompt = useMemo(
    () => config.prompts.find((item) => item.id === selectedId),
    [config.prompts, selectedId]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getSystemPromptConfig().then((next) => {
      if (cancelled) return;
      setConfig(next);
      setSelectedId((prev) => {
        const selectedExists = next.prompts.some((item) => item.id === prev);
        return selectedExists ? prev : (next.defaultPromptId ?? "builtin-default");
      });
    }).catch((error) => {
      if (cancelled) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [setConfig, setSelectedId]);

  useEffect(() => {
    if (!selectedPrompt) return;
    setEditName(selectedPrompt.name);
    setEditContent(selectedPrompt.content);
  }, [selectedPrompt]);

  useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, []);

  const debounceSave = (id: string, input: SystemPromptUpdateInput): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void updateSystemPrompt(id, input).then((updated) => {
        setConfig((prev) => ({
          ...prev,
          prompts: prev.prompts.map((item) => (item.id === updated.id ? updated : item))
        }));
      }).catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }, DEBOUNCE_DELAY_MS);
  };

  const handleCreate = async (): Promise<void> => {
    const input: SystemPromptCreateInput = {
      name: "新提示词",
      content: ""
    };
    try {
      const created = await createSystemPrompt(input);
      setConfig((prev) => ({
        ...prev,
        prompts: [...prev.prompts, created]
      }));
      setSelectedId(created.id);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await deleteSystemPrompt(id);
      setConfig((prev) => {
        const prompts = prev.prompts.filter((item) => item.id !== id);
        const nextDefault = prev.defaultPromptId === id ? "builtin-default" : prev.defaultPromptId;
        return {
          ...prev,
          prompts,
          defaultPromptId: nextDefault
        };
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
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await setDefaultSystemPrompt(id);
      setConfig((prev) => ({
        ...prev,
        defaultPromptId: id
      }));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleNameChange = (value: string): void => {
    setEditName(value);
    if (!selectedPrompt || selectedPrompt.isBuiltin) return;
    debounceSave(selectedPrompt.id, { name: value });
  };

  const handleContentChange = (value: string): void => {
    setEditContent(value);
    if (!selectedPrompt || selectedPrompt.isBuiltin) return;
    debounceSave(selectedPrompt.id, { content: value });
  };

  const handleAppendChange = async (enabled: boolean): Promise<void> => {
    try {
      await updateSystemPromptAppendSetting(enabled);
      setConfig((prev) => ({
        ...prev,
        appendDateTimeAndUserName: enabled
      }));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        title="系统提示词"
        description="管理 Chat 模式默认 system prompt"
        action={(
          <Button size="sm" type="button" onClick={() => { void handleCreate(); }}>
            <Plus className="mr-1 size-4" />
            新建
          </Button>
        )}
      >
        <SettingsCard divided={false} className="p-0">
          {loading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">加载中...</div>
          ) : (
            <div className="divide-y divide-border/50">
              {config.prompts.map((prompt) => (
                <PromptListItem
                  key={prompt.id}
                  prompt={prompt}
                  isSelected={prompt.id === selectedId}
                  isDefault={prompt.id === defaultPromptId}
                  isHovered={prompt.id === hoveredId}
                  onSelect={(id) => setSelectedId(id)}
                  onDelete={(id) => { void handleDelete(id); }}
                  onSetDefault={(id) => { void handleSetDefault(id); }}
                  onHoverChange={setHoveredId}
                />
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {selectedPrompt ? (
        <SettingsSection title="提示词内容">
          <SettingsCard divided={false} className="space-y-3 p-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">名称</label>
              <Input
                value={editName}
                onChange={(event) => handleNameChange(event.target.value)}
                readOnly={selectedPrompt.isBuiltin}
                maxLength={50}
                className={cn(selectedPrompt.isBuiltin && "cursor-not-allowed opacity-60")}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">内容</label>
              <textarea
                value={editContent}
                onChange={(event) => handleContentChange(event.target.value)}
                readOnly={selectedPrompt.isBuiltin}
                className={cn(
                  "min-h-[280px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  selectedPrompt.isBuiltin && "cursor-not-allowed opacity-60"
                )}
                placeholder="输入系统提示词内容..."
              />
            </div>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title="增强选项">
        <SettingsCard>
          <SettingsToggle
            label="追加日期时间和用户名"
            description="在提示词末尾自动追加当前日期时间与用户名"
            checked={config.appendDateTimeAndUserName}
            onCheckedChange={(checked) => { void handleAppendChange(checked); }}
          />
        </SettingsCard>
      </SettingsSection>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}

interface PromptListItemProps {
  prompt: SystemPrompt;
  isSelected: boolean;
  isDefault: boolean;
  isHovered: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  onHoverChange: (id: string | null) => void;
}

function PromptListItem({
  prompt,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange
}: PromptListItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors",
        isSelected ? "bg-accent/50" : "hover:bg-muted/50"
      )}
      onClick={() => onSelect(prompt.id)}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{prompt.name}</span>
        {prompt.isBuiltin ? <span className="shrink-0 text-xs text-muted-foreground">(内置)</span> : null}
        {isDefault ? <Star className="size-3.5 shrink-0 fill-amber-500 text-amber-500" /> : null}
      </div>

      <div className={cn(
        "flex shrink-0 items-center gap-1 transition-opacity",
        isHovered ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      >
        {!isDefault ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(event) => {
              event.stopPropagation();
              onSetDefault(prompt.id);
            }}
            title="设为默认"
          >
            <Star className="size-3.5 text-muted-foreground" />
          </Button>
        ) : null}
        {!prompt.isBuiltin ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(prompt.id);
            }}
            title="删除"
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
