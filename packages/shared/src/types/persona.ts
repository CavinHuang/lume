// packages/shared/src/types/persona.ts
export interface PersonaProfile {
  name?: string;
  summary?: string;
  preferences: string[];
  interactionRules: string[];
  evolution: string[];
  updatedAt?: string;
}

export interface PersonaGetResult {
  markdown: string;
  parsed: PersonaProfile;
  updatedAt?: string;
}

export interface PersonaCorrectionInput {
  workspaceSlug: string;
  correction: string;
}

export const PERSONA_IPC_CHANNELS = {
  GET: "persona:get",
  UPDATE: "persona:update",
  CORRECT: "persona:correct",
  REGENERATE: "persona:regenerate",
} as const;
