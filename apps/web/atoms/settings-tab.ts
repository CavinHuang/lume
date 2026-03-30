import { atom } from "jotai";

export type SettingsTab = "general" | "models" | "prompts" | "tools" | "tutorial" | "about" | "agent" | "automation" | "identity" | "skills";

export const settingsTabAtom = atom<SettingsTab>("models");
