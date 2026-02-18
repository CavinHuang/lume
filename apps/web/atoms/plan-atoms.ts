import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { PlanStateChangedEvent } from "@lume/shared";

export type PlanPhase = "idle" | "planning" | "review" | "executing" | "executed";

export interface PlanDraft {
  content: string;
  updatedAt: number;
}

export interface PlanFile {
  path: string | null;
  slug: string | null;
  savedAt: number | null;
}

export interface PlanMetadata {
  summary?: string;
  estimatedFiles?: number;
  estimatedLines?: number;
}

export interface PlanState {
  phase: PlanPhase;
  sessionActive: boolean;
  draft: PlanDraft;
  file: PlanFile;
  metadata: PlanMetadata;
  reviewOpen: boolean;
}

const INITIAL_PLAN_STATE: PlanState = {
  phase: "idle",
  sessionActive: false,
  draft: {
    content: "",
    updatedAt: 0
  },
  file: {
    path: null,
    slug: null,
    savedAt: null
  },
  metadata: {},
  reviewOpen: false
};

function normalizePlanState(raw: unknown): PlanState {
  if (!raw || typeof raw !== "object") return INITIAL_PLAN_STATE;
  const value = raw as Partial<PlanState> & {
    draft?: Partial<PlanDraft>;
    file?: Partial<PlanFile>;
    metadata?: Partial<PlanMetadata>;
  };

  const phase = typeof value.phase === "string"
    && ["idle", "planning", "review", "executing", "executed"].includes(value.phase)
    ? (value.phase as PlanPhase)
    : INITIAL_PLAN_STATE.phase;

  return {
    phase,
    sessionActive: typeof value.sessionActive === "boolean"
      ? value.sessionActive
      : phase === "planning",
    draft: {
      content: typeof value.draft?.content === "string" ? value.draft.content : "",
      updatedAt: typeof value.draft?.updatedAt === "number" ? value.draft.updatedAt : 0
    },
    file: {
      path: typeof value.file?.path === "string" ? value.file.path : null,
      slug: typeof value.file?.slug === "string" ? value.file.slug : null,
      savedAt: typeof value.file?.savedAt === "number" ? value.file.savedAt : null
    },
    metadata: {
      ...(typeof value.metadata?.summary === "string" ? { summary: value.metadata.summary } : {}),
      ...(typeof value.metadata?.estimatedFiles === "number" ? { estimatedFiles: value.metadata.estimatedFiles } : {}),
      ...(typeof value.metadata?.estimatedLines === "number" ? { estimatedLines: value.metadata.estimatedLines } : {})
    },
    reviewOpen: typeof value.reviewOpen === "boolean"
      ? value.reviewOpen
      : phase === "review"
  };
}

export const planStateAtom = atomWithStorage<PlanState>(
  "lume-plan-state",
  INITIAL_PLAN_STATE,
  {
    getItem: (key) => {
      const stored = sessionStorage.getItem(key);
      if (!stored) return INITIAL_PLAN_STATE;
      try {
        return normalizePlanState(JSON.parse(stored));
      } catch {
        return INITIAL_PLAN_STATE;
      }
    },
    setItem: (key, value) => {
      sessionStorage.setItem(key, JSON.stringify(value));
    },
    removeItem: (key) => {
      sessionStorage.removeItem(key);
    }
  }
);

export const isPlanModeActiveAtom = atom<boolean>((get) => {
  const state = get(planStateAtom);
  return state.phase === "planning" || state.phase === "review";
});

export const planPhaseAtom = atom<PlanPhase>((get) => get(planStateAtom).phase);

export const enterPlanModeAtom = atom(null, (get, set) => {
  const current = get(planStateAtom);
  set(planStateAtom, {
    ...current,
    phase: "planning",
    sessionActive: true,
    draft: { content: "", updatedAt: Date.now() },
    file: { path: null, slug: null, savedAt: null },
    metadata: {},
    reviewOpen: false
  });
});

export const updatePlanDraftAtom = atom(null, (get, set, content: string) => {
  const current = get(planStateAtom);
  if (current.phase !== "planning") return;
  set(planStateAtom, {
    ...current,
    draft: { content, updatedAt: Date.now() }
  });
});

export const appendPlanDraftAtom = atom(null, (get, set, text: string) => {
  const current = get(planStateAtom);
  if (current.phase !== "planning") return;
  set(planStateAtom, {
    ...current,
    draft: {
      content: current.draft.content + text,
      updatedAt: Date.now()
    }
  });
});

export const exitPlanModeAtom = atom(
  null,
  (get, set, payload?: { planPath?: string; slug?: string; metadata?: PlanMetadata }) => {
    const current = get(planStateAtom);
    set(planStateAtom, {
      ...current,
      phase: "review",
      sessionActive: false,
      reviewOpen: true,
      file: payload?.planPath
        ? { path: payload.planPath, slug: payload.slug ?? null, savedAt: Date.now() }
        : current.file,
      metadata: payload?.metadata ?? current.metadata
    });
  }
);

export const applyPlanStateChangedAtom = atom(null, (get, set, event: PlanStateChangedEvent) => {
  const current = get(planStateAtom);
  set(planStateAtom, {
    ...current,
    phase: event.phase,
    sessionActive: event.phase === "planning",
    reviewOpen: event.phase === "review",
    file: event.planPath
      ? {
          ...current.file,
          path: event.planPath,
          savedAt: Date.now()
        }
      : current.file
  });
});

export const setPlanPhaseAtom = atom(null, (get, set, phase: PlanPhase) => {
  const current = get(planStateAtom);
  set(planStateAtom, {
    ...current,
    phase,
    sessionActive: phase === "planning",
    reviewOpen: phase === "review"
  });
});

export const resetPlanStateAtom = atom(null, (get, set) => {
  set(planStateAtom, INITIAL_PLAN_STATE);
});
