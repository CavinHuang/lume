"use client";

import { useAtomValue } from "jotai";
import { activeViewAtom, appModeAtom } from "@/atoms";
import { ChatView } from "@/components/chat";
import { AgentView } from "@/components/agent";
import { SettingsPanel } from "@/components/settings";

export function MainContentPanel(): React.ReactElement {
  const mode = useAtomValue(appModeAtom);
  const activeView = useAtomValue(activeViewAtom);
  const panelClass =
    "w-full min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-slate-950/60 backdrop-blur";

  if (activeView === "settings") {
    return (
      <section className={panelClass}>
        <SettingsPanel />
      </section>
    );
  }

  return (
    <section className={panelClass}>
      {mode === "chat" ? <ChatView /> : <AgentView />}
    </section>
  );
}
