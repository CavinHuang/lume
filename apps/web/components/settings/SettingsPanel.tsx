"use client";

import { useAtom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { BookOpen, Info, Palette, Plug, Radio, Settings, Wrench } from "lucide-react";
import { appModeAtom, hasUpdateAtom, settingsTabAtom, type SettingsTab } from "@/atoms";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";

type TabItem = {
  id: SettingsTab;
  label: string;
  icon: ReactNode;
};

const BASE_TABS: TabItem[] = [
  { id: "general", label: "通用", icon: <Settings size={16} /> },
  { id: "channels", label: "渠道", icon: <Radio size={16} /> },
  { id: "prompts", label: "提示词", icon: <BookOpen size={16} /> },
  { id: "tools", label: "工具", icon: <Wrench size={16} /> }
];

const AGENT_TAB: TabItem = { id: "agent", label: "配置", icon: <Plug size={16} /> };

const TAIL_TABS: TabItem[] = [
  { id: "appearance", label: "外观", icon: <Palette size={16} /> },
  { id: "about", label: "关于", icon: <Info size={16} /> }
];

function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "agent":
      return <AgentSettings />;
    case "prompts":
      return <PromptSettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
  }
}

export function SettingsPanel(): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);

  const tabs = appMode === "agent"
    ? [...BASE_TABS, AGENT_TAB, ...TAIL_TABS]
    : [...BASE_TABS, ...TAIL_TABS];

  return (
    <div className="flex h-full">
      <div className="w-[180px] border-r border-border/50 px-2 pt-14">
        <h2 className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          设置
        </h2>
        <nav className="flex flex-col gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                activeTab === tab.id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.id === "about" && hasUpdate ? <span className="h-2 w-2 rounded-full bg-red-500" /> : null}
            </button>
          ))}
        </nav>
      </div>

      <ScrollArea className="flex-1 pt-14">
        <div className="px-6 pb-6">{renderTabContent(activeTab)}</div>
      </ScrollArea>
    </div>
  );
}
