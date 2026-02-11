"use client";

import { useEffect, useState } from "react";
import { desktopHealthcheck, sidecarHealthcheck } from "@/lib/desktop-api";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type HealthState = {
  desktop: string;
  sidecar: string;
};

export function AboutSettings(): React.ReactElement {
  const [health, setHealth] = useState<HealthState>({ desktop: "checking", sidecar: "checking" });

  useEffect(() => {
    void (async () => {
      const [desktop, sidecar] = await Promise.allSettled([
        desktopHealthcheck(),
        sidecarHealthcheck()
      ]);

      setHealth({
        desktop: desktop.status === "fulfilled" && desktop.value.ok ? "ok" : "error",
        sidecar: sidecar.status === "fulfilled" && sidecar.value.ok ? "ok" : "error"
      });
    })();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="About Lume" description="Proma -> Lume migration track">
        <SettingsCard>
          <SettingsRow label="Frontend Stack" description="Next.js + Tailwind + shadcn/ui" />
          <SettingsRow label="Desktop Runtime" description={`desktop: ${health.desktop} · sidecar: ${health.sidecar}`} />
          <SettingsRow label="Storage Mode" description="File-first (JSON/JSONL), SQLite design drafted" />
          <SettingsRow label="Migration Status" description="MIG-001..MIG-015 in active execution notes" />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
