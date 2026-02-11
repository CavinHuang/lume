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
    <div className="grid grid-cols-2 gap-1.5">
      {MODE_ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={cn(
            "rounded-md border border-transparent px-3 py-2 text-sm font-semibold transition-colors",
            mode === item.value
              ? "border-cyan-300/60 bg-cyan-500 text-cyan-950"
              : "text-muted-foreground hover:bg-slate-800/80 hover:text-foreground"
          )}
          onClick={() => setMode(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
