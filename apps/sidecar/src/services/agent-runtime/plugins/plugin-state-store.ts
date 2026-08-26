import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SensitiveApprovalRecord } from "@lume/agent-sdk";
import { backupCorruptFile } from "../../infra/corrupt-file-backup";
import { createLogger } from "../../infra/logger";

const log = createLogger("plugin-state-store");

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
  /** #596③：串行化 RMW——appendSensitiveApproval 的读改写之间有两个 await，
   * 并发审批会互相覆盖丢安全审计记录。promise 链保证逐条落盘。
   * static=跨实例共享（plugin-manager/attempt/run/market-service 各自 new 实例
   * 常指向同一路径）；残余竞态：market-service 自身的裸 read→write RMW 未入链。 */
  static #writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<PluginStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as Partial<PluginStateFile>;
      return { plugins: raw.plugins ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { plugins: {} };
      }
      // #596③：损坏文件改名保留现场后重建，install/uninstall/审批门不再被
      // 一个坏文件永久锁死（backupCorruptFile 共享收口）
      // 改名失败已由 backupCorruptFile 统一告警，此处只记成功分支
      const backupPath = backupCorruptFile(this.path);
      if (backupPath) log.warn("plugins-state file was corrupt; backed up and rebuilt", { backupPath });
      return { plugins: {} };
    }
  }

  async write(state: PluginStateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await rename(tmp, this.path);
  }

  /**
   * Append a single sensitive-approval record to a plugin's install record (read-modify-write).
   * Targets the same source `collectSensitiveApprovals` (permission-runtime.ts) reads from so the
   * next `checkSensitiveCapability` observes the record: activeVersion's version → else first
   * external entry → else approvalsByHash[record.permissionsHash || "default"]. Serialized via
   * a promise chain so concurrent approvals cannot interleave their read-modify-write.
   */
  appendSensitiveApproval(input: {
    pluginId: string;
    record: SensitiveApprovalRecord;
  }): Promise<void> {
    FilePluginStateStore.#writeChain = FilePluginStateStore.#writeChain.then(
      () => this.doAppendSensitiveApproval(input),
      () => this.doAppendSensitiveApproval(input),
    );
    return FilePluginStateStore.#writeChain;
  }

  private async doAppendSensitiveApproval(input: {
    pluginId: string;
    record: SensitiveApprovalRecord;
  }): Promise<void> {
    const state = await this.read();
    const rec = state.plugins[input.pluginId];
    if (!rec) {
      throw new Error(`appendSensitiveApproval: plugin not found: ${input.pluginId}`);
    }
    let target: { sensitiveApprovals: SensitiveApprovalRecord[] } | undefined;
    if (rec.activeVersion && rec.versions[rec.activeVersion]) {
      target = rec.versions[rec.activeVersion];
    } else {
      const external = Object.values(rec.external ?? {})[0];
      if (external) {
        target = external;
      }
    }
    if (!target) {
      const hash = input.record.permissionsHash || "default";
      rec.approvalsByHash[hash] ??= {
        permissionsHash: input.record.permissionsHash,
        sensitiveApprovals: [],
      };
      target = rec.approvalsByHash[hash];
    }
    target.sensitiveApprovals.push(input.record);
    await this.write(state);
  }
}
