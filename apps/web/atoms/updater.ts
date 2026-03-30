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

/**
 * @deprecated 自动更新功能尚未接入，此 atom 始终返回 false。
 * 接入更新通道后请移除此标记。
 */
export const updaterAvailableAtom = atom<boolean>(() => {
  return false;
});

/**
 * @deprecated 自动更新功能尚未接入，始终返回 error 状态。
 * 接入更新通道后请替换为真实实现。
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  return {
    status: "error",
    error: "当前版本暂未接入自动更新服务"
  };
}

/**
 * @deprecated 自动更新功能尚未接入，始终返回 error 状态。
 * 接入更新通道后请替换为真实实现。
 */
export async function installUpdate(): Promise<UpdateStatus> {
  return {
    status: "error",
    error: "当前版本暂未接入自动更新安装能力"
  };
}
