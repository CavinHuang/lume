import {
  normalizeLumeCapabilityReferences,
  parseLumeCapabilityReference,
  type LumeCapabilityReference,
} from "@lume/agent-sdk";
import type { AgentLinkConnectionRefPart, AgentSendInput, AgentUserMessagePart } from "@lume/shared";
import { validatePlanningTodoRefPart } from "@lume/shared";

export type AgentUserMessagePartsErrorCode =
  | "message_mismatch"
  | "duplicate_occurrence"
  | "invalid_reference"
  | "invalid_link_connection_reference"
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
  linkConnectionReferences: AgentLinkConnectionRefPart[];
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
      if (part.type === "link_connection_ref") return `@${part.displayText}`;
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
  const linkConnectionReferences = new Map<string, AgentLinkConnectionRefPart>();
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
    if (part.type === "link_connection_ref") {
      if (!isValidLinkConnectionReference(part)) {
        throw new AgentUserMessagePartsError(
          "invalid_link_connection_reference",
          `Invalid Link connection reference: ${part.service}:${part.connectionName}`
        );
      }
      const key = `${part.service}\u0000${part.connectionName}`;
      if (!linkConnectionReferences.has(key)) linkConnectionReferences.set(key, { ...part });
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
        if (part.type === "link_connection_ref") return "";
        return "";
      })
      .join(""),
    capabilityReferences: normalizeLumeCapabilityReferences(rawReferences),
    linkConnectionReferences: [...linkConnectionReferences.values()],
  };
}

export function buildLinkConnectionReferenceContext(references: AgentLinkConnectionRefPart[]): string {
  if (references.length === 0) return "";
  const bindings = references.map(({ service, connectionName }) => ({ service, connectionName }));
  return [
    "<preferred_connector_connections>",
    "Use these named Connector accounts by default for their services. They are preferences, not exclusive restrictions. Do not silently fall back when a preferred account needs authorization; let the normal authorization flow handle that account. An explicitly supplied connectionName may select another account.",
    JSON.stringify(bindings),
    "</preferred_connector_connections>",
  ].join("\n");
}

function isValidLinkConnectionReference(part: AgentLinkConnectionRefPart): boolean {
  return part.schemaVersion === 1
    && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(part.service)
    && validDisplayComponent(part.connectionName, 256)
    && validDisplayComponent(part.displayText, 256);
}

function validDisplayComponent(value: string, maxLength: number): boolean {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}
