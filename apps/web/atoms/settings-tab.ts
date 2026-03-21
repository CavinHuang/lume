import { atom } from "jotai";

export type SettingsTab = "general" | "channels" | "prompts" | "tools" | "appearance" | "about" | "agent";

export const settingsTabAtom = atom<SettingsTab>("channels");
