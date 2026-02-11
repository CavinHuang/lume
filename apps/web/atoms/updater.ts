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

export const updaterAvailableAtom = atom<boolean>(() => {
  // Lume 当前未接入 Proma 的 updater 通道，保持不可用状态。
  return false;
});

export async function checkForUpdates(): Promise<UpdateStatus> {
  // Lume(Tauri) 尚未接入自动更新通道，先返回可感知状态，避免无反馈。
  return {
    status: "error",
    error: "当前版本暂未接入自动更新服务"
  };
}

export async function installUpdate(): Promise<UpdateStatus> {
  return {
    status: "error",
    error: "当前版本暂未接入自动更新安装能力"
  };
}
