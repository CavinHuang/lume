import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { TaskContractRecord } from "./task-contract-record-types";

export interface TaskContractStore {
  upsert(contract: TaskContractRecord): Promise<void>;
  get(contractId: string): Promise<TaskContractRecord | null>;
  listByThread(threadId: string): Promise<TaskContractRecord[]>;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readTaskContract(path: string): TaskContractRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskContractRecord;
  } catch {
    return null;
  }
}

class FileBackedTaskContractStore implements TaskContractStore {
  private readonly contractsDir: string;

  constructor(sessionDir: string) {
    this.contractsDir = join(sessionDir, "task-contracts");
    mkdirSync(this.contractsDir, { recursive: true });
  }

  async upsert(contract: TaskContractRecord): Promise<void> {
    writeTextAtomic(this.pathFor(contract.id), JSON.stringify(contract, null, 2));
  }

  async get(contractId: string): Promise<TaskContractRecord | null> {
    return readTaskContract(this.pathFor(contractId));
  }

  async listByThread(threadId: string): Promise<TaskContractRecord[]> {
    if (!existsSync(this.contractsDir)) return [];
    const contracts: TaskContractRecord[] = [];
    for (const file of readdirSync(this.contractsDir)) {
      if (!file.endsWith(".json")) continue;
      const contract = readTaskContract(join(this.contractsDir, file));
      if (contract?.threadId === threadId) contracts.push(contract);
    }
    return contracts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private pathFor(contractId: string): string {
    return join(this.contractsDir, `${contractId.replace(/[^a-zA-Z0-9._:-]/g, "_")}.json`);
  }
}

export function createFileBackedTaskContractStore(sessionDir: string): TaskContractStore {
  return new FileBackedTaskContractStore(sessionDir);
}
