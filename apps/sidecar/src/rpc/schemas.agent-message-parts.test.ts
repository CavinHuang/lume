import { describe, expect, test } from "bun:test";
import { agentSendInputSchema } from "./schemas";

describe("agentSendInputSchema messageParts", () => {
  test("accepts legacy messages without parts", () => {
    expect(agentSendInputSchema.parse({ threadId: "thread-1", userMessage: "hello" })).toMatchObject({
      userMessage: "hello"
    });
  });

  test("accepts matching canonical capability refs", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "Use lume-plugin://browser",
      clientSubmissionId: "8312d8d1-bc7b-4e93-a2ca-b6a4ca8ad503",
      messageParts: [
        { type: "text", text: "Use " },
        { type: "capability_ref", occurrenceId: "plugin-1", uri: "lume-plugin://browser" }
      ]
    });
    expect(parsed.messageParts).toHaveLength(2);
  });

  test("rejects mismatches, duplicate occurrences, and malformed refs", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "hello",
      messageParts: [{ type: "text", text: "different" }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "lume-skill://a lume-skill://b",
      messageParts: [
        { type: "capability_ref", occurrenceId: "same", uri: "lume-skill://a" },
        { type: "text", text: " " },
        { type: "capability_ref", occurrenceId: "same", uri: "lume-skill://b" }
      ]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "lume-skill://bad space",
      messageParts: [
        { type: "capability_ref", occurrenceId: "bad", uri: "lume-skill://bad space" }
      ]
    })).toThrow();
  });
});
