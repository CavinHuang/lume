import {
  normalizeLumeCapabilityReferences,
  parseLumeCapabilityReference,
  type LumeCapabilityReference,
} from "@lume/agent-sdk";
import type { AgentSendInput, AgentUserMessagePart } from "@lume/shared";

export type AgentUserMessagePartsErrorCode =
  | "message_mismatch"
  | "duplicate_occurrence"
  | "invalid_reference";

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
  input: Pick<AgentSendInput, "userMessage" | "messageParts">
): NormalizedAgentUserMessage {
  const parts: AgentUserMessagePart[] = input.messageParts
    ? input.messageParts.map((part) => ({ ...part }))
    : [{ type: "text", text: input.userMessage }];
  const visibleMessage = parts
    .map((part) => part.type === "text" ? part.text : part.uri)
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
      .filter((part): part is Extract<AgentUserMessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(""),
    capabilityReferences: normalizeLumeCapabilityReferences(rawReferences),
  };
}
