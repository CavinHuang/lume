"use client";

import { LeftSidebar } from "./LeftSidebar";
import { MainContentPanel } from "./MainContentPanel";
import { AppShellProvider, type AppShellContextType } from "@/contexts/AppShellContext";

export interface AppShellProps {
  contextValue: AppShellContextType;
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  return (
    <AppShellProvider value={contextValue}>
      <main className="h-screen w-screen overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
        <div className="titlebar-drag-region pointer-events-none fixed left-0 right-0 top-0 z-50 h-[50px]" />
        <div className="flex h-full overflow-hidden">
          <LeftSidebar />
          <div className="titlebar-no-drag relative z-[60] flex-1 min-w-0 p-2">
            <MainContentPanel />
          </div>
        </div>
      </main>
    </AppShellProvider>
  );
}
