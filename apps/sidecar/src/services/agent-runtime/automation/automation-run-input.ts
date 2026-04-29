import type { LumeRunInput } from "../runner/run-state";

export interface AutomationRunInput extends LumeRunInput {
  source: "automation";
  automation: {
    jobId: string;
    trigger: "schedule" | "webhook" | "manual" | "event";
    allowAskUser: boolean;
    allowHighRiskTools: boolean;
  };
}

