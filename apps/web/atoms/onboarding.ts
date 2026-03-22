import { atomWithStorage } from "jotai/utils";

export const onboardingDismissedAtom = atomWithStorage<boolean>("lume-onboarding-dismissed", false);
export const onboardingCompletedAtom = atomWithStorage<boolean>("lume-onboarding-completed", false);
