import { atom } from "jotai";

export type SettingsTab = "general" | "models" | "prompts" | "tools" | "about" | "agent" | "automation" | "identity" | "skills" | "im-channel";

export const settingsTabAtom = atom<SettingsTab>("models");
