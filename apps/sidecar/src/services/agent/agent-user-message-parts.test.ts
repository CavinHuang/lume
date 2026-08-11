import { describe, expect, test } from "bun:test";
import { AgentUserMessagePartsError, buildLinkConnectionReferenceContext, normalizeAgentUserMessage } from "./agent-user-message-parts";

describe("normalizeAgentUserMessage", () => {
  test("wraps legacy userMessage as non-authorizing text", () => {
    const result = normalizeAgentUserMessage({
      userMessage: "Log: lume-skill://review"
    });
    expect(result.parts).toEqual([{ type: "text", text: "Log: lume-skill://review" }]);
    expect(result.modelMessage).toBe("Log: lume-skill://review");
    expect(result.capabilityReferences).toEqual([]);
    expect(result.linkConnectionReferences).toEqual([]);
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

  test("keeps Planning Todo references out of capability projection and restores visible text with ampersand", () => {
    const todoId = "11111111-1111-4111-8111-111111111111";
    const result = normalizeAgentUserMessage({
      userMessage: "请跟进 &发布版本",
      messageParts: [{ type: "text", text: "请跟进 " }, { type: "planning_todo_ref", schemaVersion: 1, uri: `lume://planning/todo/${todoId}`, todoId, relation: "mentioned", displayText: "发布版本" }]
    });
    expect(result.visibleMessage).toBe("请跟进 &发布版本");
    expect(result.modelMessage).toContain(`<planning_todo_ref todoId="${todoId}"`);
    expect(result.capabilityReferences).toEqual([]);
  });

  test("rejects a primary Planning Todo reference on an ordinary send", () => {
    const todoId = "11111111-1111-4111-8111-111111111111";
    expect(() => normalizeAgentUserMessage({
      userMessage: "&发布版本",
      messageParts: [{ type: "planning_todo_ref", schemaVersion: 1, uri: `lume://planning/todo/${todoId}`, todoId, relation: "primary", displayText: "发布版本" }]
    })).toThrow("primary");
    expect(() => normalizeAgentUserMessage({
      userMessage: "&发布版本",
      messageParts: [{ type: "planning_todo_ref", schemaVersion: 1, uri: `lume://planning/todo/${todoId}`, todoId, relation: "primary", displayText: "发布版本" }]
    }, { allowPrimaryPlanningTodo: true })).not.toThrow();
  });

  test("normalizes and deduplicates preferred Link connection references", () => {
    const gmail = { type: "link_connection_ref" as const, schemaVersion: 1 as const, service: "gmail", connectionName: "work", displayText: "Gmail · user@example.com" };
    const result = normalizeAgentUserMessage({
      userMessage: "检查 @Gmail · user@example.com 和 @Gmail · user@example.com",
      messageParts: [
        { type: "text", text: "检查 " },
        gmail,
        { type: "text", text: " 和 " },
        gmail,
      ]
    });

    expect(result.visibleMessage).toBe("检查 @Gmail · user@example.com 和 @Gmail · user@example.com");
    expect(result.modelMessage).toContain('检查 <link_connection_ref>{"service":"gmail","connectionName":"work"');
    expect(result.modelMessage).toContain(" 和 <link_connection_ref>");
    expect(result.linkConnectionReferences).toEqual([gmail]);
    expect(buildLinkConnectionReferenceContext(result.linkConnectionReferences)).toContain(
      '[{"service":"gmail","connectionName":"work"}]'
    );
  });

  test("preserves source and destination account positions in model text", () => {
    const result = normalizeAgentUserMessage({
      userMessage: "从 @Gmail · 工作 复制到 @Gmail · 个人",
      messageParts: [
        { type: "text", text: "从 " },
        { type: "link_connection_ref", schemaVersion: 1, service: "gmail", connectionName: "work", displayText: "Gmail · 工作" },
        { type: "text", text: " 复制到 " },
        { type: "link_connection_ref", schemaVersion: 1, service: "gmail", connectionName: "personal", displayText: "Gmail · 个人" },
      ],
    });

    expect(result.modelMessage).toContain('"connectionName":"work","displayText":"Gmail · 工作"}</link_connection_ref> 复制到 <link_connection_ref>');
    expect(result.modelMessage).toContain('"connectionName":"personal"');
  });

  test("rejects malformed Link connection references", () => {
    expect(() => normalizeAgentUserMessage({
      userMessage: "@Gmail",
      messageParts: [{ type: "link_connection_ref", schemaVersion: 1, service: "Gmail!", connectionName: "work", displayText: "Gmail" }]
    })).toThrow("Invalid Link connection reference");
  });
});
