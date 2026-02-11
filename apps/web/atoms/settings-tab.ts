import { atom } from "jotai";

export type SettingsTab = "general" | "channels" | "appearance" | "about" | "agent";

export const settingsTabAtom = atom<SettingsTab>("channels");
