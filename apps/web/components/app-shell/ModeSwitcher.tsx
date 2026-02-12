"use client";

import { useAtom } from "jotai";
import { appModeAtom, type AppMode } from "@/atoms";
import { cn } from "@/lib/utils";

const MODE_ITEMS: Array<{ value: AppMode; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "agent", label: "Agent" }
];

export function ModeSwitcher(): React.ReactElement {
  const [mode, setMode] = useAtom(appModeAtom);

  return (
    <div className="titlebar-no-drag px-2 pt-2">
      <div className="flex rounded-lg bg-muted p-1">
      {MODE_ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={cn(
            "titlebar-no-drag flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            mode === item.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setMode(item.value)}
        >
          {item.label}
        </button>
      ))}
      </div>
    </div>
  );
}
