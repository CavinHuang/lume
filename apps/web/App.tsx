"use client";

import { AppShell } from "./components/app-shell/AppShell";
import { TooltipProvider } from './components/ui/tooltip'

export default function App(): React.ReactElement {
  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  );
}
