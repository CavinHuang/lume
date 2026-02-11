"use client";

import { useState } from "react";
import type { HealthcheckResult } from "@lume/shared";
import { desktopHealthcheck } from "@/lib/desktop-api";

export default function HomePage() {
  const [status, setStatus] = useState<HealthcheckResult | null>(null);

  return (
    <main>
      <section className="card">
        <h1>Lume Bootstrap</h1>
        <p>Monorepo skeleton is active. Desktop bridge and sidecar hook are wired.</p>
        <div className="row">
          <button
            type="button"
            onClick={async () => {
              const result = await desktopHealthcheck();
              setStatus(result);
            }}
          >
            Run Desktop Healthcheck
          </button>
          <code>{status ? JSON.stringify(status) : "no result"}</code>
        </div>
      </section>
    </main>
  );
}

