import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SensitiveApprovalRecord } from "@lume/agent-sdk";

/** Shared plugin sensitive-approval state file (read by the start gate, call gate, hook gate). */
export const DEFAULT_PLUGIN_STATE_PATH = join(homedir(), ".lume", "plugins-state.json");

export interface PluginStateFile {
  plugins: Record<string, PluginInstallRecord>;
}

export interface PluginInstallRecord {
  pluginId: string;
  activeVersion?: string;
  versions: Record<string, PluginInstalledVersion>;
  external?: Record<string, PluginExternalState>;
  approvalsByHash: Record<string, PluginApprovalBundle>;
}

export interface PluginInstalledVersion {
  pluginId: string;
  version: string;
  source: unknown;
  installedRoot: string;
  installedAt: string;
  trustedAt?: string;
  permissionsAcceptedAt?: string;
  permissionsHash?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export interface PluginExternalState {
  sourceKey: string;
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export interface PluginApprovalBundle {
  permissionsHash: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export class FilePluginStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<PluginStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as Partial<PluginStateFile>;
      return { plugins: raw.plugins ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { plugins: {} };
      }
      throw error;
    }
  }

  async write(state: PluginStateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await rename(tmp, this.path);
  }
}
