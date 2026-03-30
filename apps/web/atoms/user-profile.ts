import { atomWithStorage } from "jotai/utils";

export type UserProfile = {
  userName: string;
  avatar: string;
};

const defaultUserProfile: UserProfile = { userName: "You", avatar: "🙂" };

export const userProfileAtom = atomWithStorage<UserProfile>("lume-user-profile", defaultUserProfile);
