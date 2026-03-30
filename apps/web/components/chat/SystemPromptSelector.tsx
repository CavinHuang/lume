import { useEffect, useMemo } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { BookOpen, Check, Pencil, Star } from "lucide-react";
import {
  conversationPromptIdAtom,
  currentConversationIdAtom,
  defaultPromptIdAtom,
  promptSidebarOpenAtom,
  promptConfigAtom,
  selectedPromptIdAtom
} from "@/atoms";
import { getSystemPromptConfig } from "@/lib/desktop-api/chat";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

export function SystemPromptSelector(): React.ReactElement | null {
  const currentConversationId = useAtomValue(currentConversationIdAtom);
  const [promptConfig, setPromptConfig] = useAtom(promptConfigAtom);
  const selectedPromptId = useAtomValue(selectedPromptIdAtom);
  const defaultPromptId = useAtomValue(defaultPromptIdAtom);
  const [conversationPromptMap, setConversationPromptMap] = useAtom(conversationPromptIdAtom);
  const setPromptSidebarOpen = useSetAtom(promptSidebarOpenAtom);

  useEffect(() => {
    void getSystemPromptConfig().then((config) => {
      setPromptConfig(config);
    }).catch((error) => {
      console.error("[SystemPromptSelector] 加载提示词配置失败:", error);
    });
  }, [setPromptConfig]);

  const effectivePromptId = useMemo(() => {
    if (!currentConversationId) return selectedPromptId;
    return conversationPromptMap.get(currentConversationId) ?? selectedPromptId;
  }, [conversationPromptMap, currentConversationId, selectedPromptId]);

  const selectedPrompt = useMemo(
    () => promptConfig.prompts.find((item) => item.id === effectivePromptId),
    [promptConfig.prompts, effectivePromptId]
  );

  if (!currentConversationId) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={selectedPrompt ? `提示词: ${selectedPrompt.name}` : "选择提示词"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <BookOpen className="size-4" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="z-[60] w-56">
        {promptConfig.prompts.map((prompt) => (
          <DropdownMenuItem
            key={prompt.id}
            onSelect={() => {
              setConversationPromptMap((prev) => {
                const next = new Map(prev);
                next.set(currentConversationId, prompt.id);
                return next;
              });
            }}
            className="gap-2"
          >
            <Check className={cn("size-4 shrink-0", prompt.id === effectivePromptId ? "opacity-100" : "opacity-0")} />
            <span className="flex-1 truncate">{prompt.name}</span>
            {prompt.isBuiltin ? <span className="shrink-0 text-xs text-muted-foreground">(内置)</span> : null}
            {prompt.id === defaultPromptId ? <Star className="size-3 shrink-0 fill-amber-500 text-amber-500" /> : null}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setPromptSidebarOpen(true);
          }}
          className="gap-2"
        >
          <Pencil className="size-4" />
          <span>编辑提示词</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
