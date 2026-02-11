import { atom } from "jotai";

type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
};

export type UpdateStatus = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  releaseNotes?: string;
  progress?: UpdateProgress;
  error?: string;
};

export const updateStatusAtom = atom<UpdateStatus>({ status: "idle" });

export const hasUpdateAtom = atom((get) => {
  const status = get(updateStatusAtom).status;
  return status === "available" || status === "downloaded";
});
