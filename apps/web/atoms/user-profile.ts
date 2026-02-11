import { atom } from "jotai";

export type UserProfile = {
  userName: string;
  avatar: string;
};

const STORAGE_KEY = "lume-user-profile";

function loadUserProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { userName: "You", avatar: "🙂" };
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    return {
      userName: parsed.userName?.trim() || "You",
      avatar: parsed.avatar?.trim() || "🙂"
    };
  } catch {
    return { userName: "You", avatar: "🙂" };
  }
}

export const userProfileAtom = atom<UserProfile>(loadUserProfile());

export function persistUserProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // ignore
  }
}
