import { describe, expect, test } from "bun:test";
import { AgentUserMessagePartsError, normalizeAgentUserMessage } from "./agent-user-message-parts";

describe("normalizeAgentUserMessage", () => {
  test("wraps legacy userMessage as non-authorizing text", () => {
    const result = normalizeAgentUserMessage({
      userMessage: "Log: lume-skill://review"
    });
    expect(result.parts).toEqual([{ type: "text", text: "Log: lume-skill://review" }]);
    expect(result.modelMessage).toBe("Log: lume-skill://review");
    expect(result.capabilityReferences).toEqual([]);
  });

  test("removes only marked reference occurrences from model text", () => {
    const result = normalizeAgentUserMessage({
      userMessage: "Use lume-skill://review, but quote lume-skill://review in the log.",
      messageParts: [
        { type: "text", text: "Use " },
        { type: "capability_ref", occurrenceId: "ref-1", uri: "lume-skill://review" },
        { type: "text", text: ", but quote lume-skill://review in the log." }
      ]
    });
    expect(result.modelMessage).toBe("Use , but quote lume-skill://review in the log.");
    expect(result.capabilityReferences.map((reference) => reference.uri)).toEqual([
      "lume-skill://review"
    ]);
  });

  test("deduplicates refs and lets a whole plugin cover its skill refs", () => {
    const result = normalizeAgentUserMessage({
      userMessage: "lume-skill://browser:inspect lume-plugin://browser",
      messageParts: [
        { type: "capability_ref", occurrenceId: "ref-1", uri: "lume-skill://browser:inspect" },
        { type: "text", text: " " },
        { type: "capability_ref", occurrenceId: "ref-2", uri: "lume-plugin://browser" }
      ]
    });
    expect(result.capabilityReferences.map((reference) => reference.uri)).toEqual([
      "lume-plugin://browser"
    ]);
  });

  test("rejects mismatched messages and duplicate occurrences", () => {
    expect(() => normalizeAgentUserMessage({
      userMessage: "different",
      messageParts: [{ type: "text", text: "text" }]
    })).toThrow(AgentUserMessagePartsError);
    expect(() => normalizeAgentUserMessage({
      userMessage: "lume-skill://a lume-skill://b",
      messageParts: [
        { type: "capability_ref", occurrenceId: "same", uri: "lume-skill://a" },
        { type: "text", text: " " },
        { type: "capability_ref", occurrenceId: "same", uri: "lume-skill://b" }
      ]
    })).toThrow(AgentUserMessagePartsError);
  });
});
