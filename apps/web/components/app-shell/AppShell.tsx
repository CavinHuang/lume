"use client";

import { LeftSidebar } from "./LeftSidebar";
import { MainContentPanel } from "./MainContentPanel";

export function AppShell(): React.ReactElement {
  return (
    <main className="grid h-screen w-screen grid-cols-1 grid-rows-[auto_1fr] gap-3 p-3 lg:grid-cols-[280px_1fr] lg:grid-rows-1">
      <LeftSidebar />
      <div className="flex min-w-0">
        <MainContentPanel />
      </div>
    </main>
  );
}
