import {
  normalizeLumeCapabilityReferences,
  parseLumeCapabilityReference,
  type LumeCapabilityReference,
} from "@lume/agent-sdk";
import type { AgentSendInput, AgentUserMessagePart } from "@lume/shared";
import { validatePlanningTodoRefPart } from "@lume/shared";

export type AgentUserMessagePartsErrorCode =
  | "message_mismatch"
  | "duplicate_occurrence"
  | "invalid_reference"
  | "invalid_planning_todo_reference"
  | "primary_not_trusted";

export class AgentUserMessagePartsError extends Error {
  constructor(
    readonly code: AgentUserMessagePartsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentUserMessagePartsError";
  }
}

export interface NormalizedAgentUserMessage {
  parts: AgentUserMessagePart[];
  visibleMessage: string;
  modelMessage: string;
  capabilityReferences: LumeCapabilityReference[];
}

export function normalizeAgentUserMessage(
  input: Pick<AgentSendInput, "userMessage" | "messageParts">,
  options: { allowPrimaryPlanningTodo?: boolean } = {}
): NormalizedAgentUserMessage {
  const parts: AgentUserMessagePart[] = input.messageParts
    ? input.messageParts.map((part) => ({ ...part }))
    : [{ type: "text", text: input.userMessage }];
  const visibleMessage = parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "planning_todo_ref") return `&${part.displayText}`;
      return part.uri;
    })
    .join("");
  if (visibleMessage !== input.userMessage) {
    throw new AgentUserMessagePartsError(
      "message_mismatch",
      "messageParts must reproduce userMessage exactly"
    );
  }

  const occurrenceIds = new Set<string>();
  const rawReferences: LumeCapabilityReference[] = [];
  for (const part of parts) {
    if (part.type === "planning_todo_ref") {
      try {
        validatePlanningTodoRefPart(part);
      } catch {
        throw new AgentUserMessagePartsError("invalid_planning_todo_reference", `Invalid Planning Todo reference: ${part.todoId}`);
      }
      if (part.relation === "primary" && !options.allowPrimaryPlanningTodo) {
        throw new AgentUserMessagePartsError("primary_not_trusted", "普通消息不能创建 Planning Todo primary 关联");
      }
      continue;
    }
    if (part.type !== "capability_ref") continue;
    if (occurrenceIds.has(part.occurrenceId)) {
      throw new AgentUserMessagePartsError(
        "duplicate_occurrence",
        `Duplicate capability reference occurrence: ${part.occurrenceId}`
      );
    }
    occurrenceIds.add(part.occurrenceId);
    let reference: LumeCapabilityReference | null = null;
    try {
      reference = parseLumeCapabilityReference(part.uri);
    } catch {
      // Normalize parser errors into the service boundary's stable error code.
    }
    if (!reference) {
      throw new AgentUserMessagePartsError(
        "invalid_reference",
        `Invalid capability reference: ${part.uri}`
      );
    }
    rawReferences.push(reference);
  }

  return {
    parts,
    visibleMessage,
    modelMessage: parts
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "planning_todo_ref") return `<planning_todo_ref todoId="${part.todoId}" relation="${part.relation}">${part.displayText}</planning_todo_ref>`;
        return "";
      })
      .join(""),
    capabilityReferences: normalizeLumeCapabilityReferences(rawReferences),
  };
}
