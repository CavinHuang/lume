"use client";

import { useAtomValue } from "jotai";
import { activeViewAtom, appModeAtom } from "@/atoms";
import { ChatView } from "@/components/chat";
import { AgentView } from "@/components/agent";
import { SettingsPanel } from "@/components/settings";
import { Panel } from "./Panel";

export function MainContentPanel(): React.ReactElement {
  const mode = useAtomValue(appModeAtom);
  const activeView = useAtomValue(activeViewAtom);
  const renderConversations = (): React.ReactElement => (mode === "chat" ? <ChatView /> : <AgentView />);

  return (
    <Panel
      variant="grow"
      className="overflow-hidden rounded-2xl border border-border/50 bg-white/95 shadow-xl backdrop-blur-xl dark:bg-zinc-900/95"
    >
      {activeView === "settings" ? <SettingsPanel /> : renderConversations()}
    </Panel>
  );
}
