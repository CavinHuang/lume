import { atomWithStorage } from "jotai/utils";

export type AppMode = "chat" | "agent";

export const appModeAtom = atomWithStorage<AppMode>("lume-app-mode", "chat");
