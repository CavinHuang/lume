import { describe, expect, test } from "bun:test";
import { extractExplicitMemoryCandidates } from "./extraction";

describe("extractExplicitMemoryCandidates", () => {
  test("extracts explicit preference intent", () => {
    expect(extractExplicitMemoryCandidates({
      text: "以后默认用中文回答",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "默认用中文回答"
    })]);
  });

  test("extracts explicit remember intent as workspace fact", () => {
    expect(extractExplicitMemoryCandidates({
      text: "记住 Lume Memory V2 使用 Markdown 作为事实源",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "fact",
      targetScope: "workspace",
      statement: "Lume Memory V2 使用 Markdown 作为事实源"
    })]);
  });

  test("suppresses durable extraction when user says not to remember", () => {
    expect(extractExplicitMemoryCandidates({
      text: "不要记住这个：临时 token 是 abc"
    })).toEqual([]);
  });
});
