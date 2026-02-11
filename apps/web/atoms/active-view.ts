import { atom } from "jotai";

export type ActiveView = "conversations" | "settings";

export const activeViewAtom = atom<ActiveView>("conversations");
