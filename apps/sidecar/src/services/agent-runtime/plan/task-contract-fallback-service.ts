import { randomUUID } from "node:crypto";
import { verifyThreadPlanMarkdownFile, writeThreadPlanMarkdownFile } from "./plan-markdown-file-service";
import { persistTaskApprovalInterruption } from "./task-approval-service";
import type { TaskContractRecord, TaskContractRecordItem } from "./task-contract-record-types";

export async function persistFallbackTaskContractFromText(input: {
  sessionDir: string;
  threadId: string;
  runId: string;
  text: string;
  threadWorkspaceDir?: string;
  now?: () => string;
  onTaskContractUpdated?: (contract: TaskContractRecord) => void | Promise<void>;
}): Promise<TaskContractRecord | null> {
  const text = input.text.trim();
  if (!text) return null;
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const id = randomUUID();
  const planFilePath = input.threadWorkspaceDir
    ? writeThreadPlanMarkdownFile({
        threadWorkspaceDir: input.threadWorkspaceDir,
        contractId: id,
        markdown: text
      })
    : undefined;
  const planVerification = input.threadWorkspaceDir && planFilePath
    ? verifyThreadPlanMarkdownFile({
        threadWorkspaceDir: input.threadWorkspaceDir,
        planFilePath,
        now
      })
    : undefined;
  const contract: TaskContractRecord = {
    id,
    runId: input.runId,
    threadId: input.threadId,
    goal: inferGoal(text),
    summary: inferSummary(text),
    assumptions: [],
    questions: [],
    risks: [],
    steps: inferSteps(text),
    expectedChanges: {},
    status: "needs_approval",
    ...(planFilePath ? { planFilePath } : {}),
    ...(planVerification ? { planVerification } : {}),
    createdAt,
    updatedAt: createdAt
  };

  await persistTaskApprovalInterruption({
    sessionDir: input.sessionDir,
    contract,
    message: "Agent 未调用 TaskContractWrite；Lume 已将回复内容整理为待审阅计划。"
  });
  await input.onTaskContractUpdated?.(contract);
  return contract;
}

function inferGoal(text: string): string {
  const title = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && line.length <= 80);
  return title ?? "审阅当前计划";
}

function inferSummary(text: string): string {
  const paragraph = text
    .replace(/^#+\s*/gm, "")
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!paragraph) return "根据 agent 的计划回复生成的待审阅计划。";
  return paragraph.length > 240 ? `${paragraph.slice(0, 237)}...` : paragraph;
}

function inferSteps(text: string): TaskContractRecordItem[] {
  const steps = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:\d+[.)、]|[-*•])\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));

  const uniqueSteps = Array.from(new Set(steps)).slice(0, 12);
  const finalSteps = uniqueSteps.length > 0 ? uniqueSteps : ["根据计划完成调研与整理"];
  return finalSteps.map((title, index) => ({
    id: `step-${index + 1}`,
    title,
    description: title,
    type: "analyze",
    status: "pending"
  }));
}
