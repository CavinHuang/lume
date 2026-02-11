"use client";

import { useAtom } from "jotai";
import { settingsTabAtom, type SettingsTab } from "@/atoms";
import { cn } from "@/lib/utils";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AgentSettings } from "./AgentSettings";
import { AboutSettings } from "./AboutSettings";

const SETTINGS_TABS: SettingsTab[] = ["channels", "general", "appearance", "agent", "about"];

function renderTab(tab: SettingsTab): React.ReactElement {
  if (tab === "channels") return <ChannelSettings />;
  if (tab === "general") return <GeneralSettings />;
  if (tab === "appearance") return <AppearanceSettings />;
  if (tab === "agent") return <AgentSettings />;
  return <AboutSettings />;
}

export function SettingsPanel(): React.ReactElement {
  const [tab, setTab] = useAtom(settingsTabAtom);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-5">
      <h2 className="text-2xl font-semibold">Settings</h2>
      <div className="flex flex-wrap gap-2">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={cn(
              "rounded-md border border-slate-700 px-3 py-2 text-sm transition-colors",
              tab === item
                ? "bg-cyan-700 text-cyan-50"
                : "bg-slate-800 text-slate-200 hover:bg-slate-700"
            )}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {renderTab(tab)}
    </div>
  );
}
