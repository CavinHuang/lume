import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { LumePlan } from "./plan-types";

export interface LumePlanStore {
  upsert(plan: LumePlan): Promise<void>;
  get(planId: string): Promise<LumePlan | null>;
  listByThread(threadId: string): Promise<LumePlan[]>;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readPlan(path: string): LumePlan | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LumePlan;
  } catch {
    return null;
  }
}

class FileBackedLumePlanStore implements LumePlanStore {
  private readonly plansDir: string;

  constructor(sessionDir: string) {
    this.plansDir = join(sessionDir, "plans-state");
    mkdirSync(this.plansDir, { recursive: true });
  }

  async upsert(plan: LumePlan): Promise<void> {
    writeTextAtomic(this.pathFor(plan.id), JSON.stringify(plan, null, 2));
  }

  async get(planId: string): Promise<LumePlan | null> {
    return readPlan(this.pathFor(planId));
  }

  async listByThread(threadId: string): Promise<LumePlan[]> {
    if (!existsSync(this.plansDir)) return [];
    const plans: LumePlan[] = [];
    for (const file of readdirSync(this.plansDir)) {
      if (!file.endsWith(".json")) continue;
      const plan = readPlan(join(this.plansDir, file));
      if (plan?.threadId === threadId) plans.push(plan);
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private pathFor(planId: string): string {
    return join(this.plansDir, `${planId.replace(/[^a-zA-Z0-9._:-]/g, "_")}.json`);
  }
}

export function createFileBackedLumePlanStore(sessionDir: string): LumePlanStore {
  return new FileBackedLumePlanStore(sessionDir);
}
