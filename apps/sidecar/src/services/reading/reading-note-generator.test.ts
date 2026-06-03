import { describe, expect, test } from "bun:test";
import type { ReadingBook, ReadingQuoteEvidence } from "@lume/shared";
import {
  ALICE_LIKE_READING_TOOL_NAMES,
  generateReadingNoteDraft,
  READING_NOTE_GENERATOR_MAX_TURNS,
  type ReadingNoteGeneratorStreamRequest
} from "./reading-note-generator";
import type { ReadingNoteGenerationContext } from "./reading-task-runner";

describe("reading-note-generator", () => {
  test("runs an Alice-like tool loop and turns final JSON into a note draft", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const draft = await generateReadingNoteDraft(buildContext(), {
      modelRef: "test/deep-reader",
      llm: {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: "tool_call",
              id: "tc-user-memory",
              name: "alice_user_memory",
              arguments: { query: "普通生活 工作消耗", limit: 3 }
            };
            yield {
              type: "usage",
              usage: { modelRef: "test/deep-reader", promptTokens: 50, completionTokens: 8, totalTokens: 58 }
            };
            return;
          }
          yield {
            type: "text",
            text: JSON.stringify({
              title: "普通生活的确认",
              reflection: "Lume 把这句划线和用户最近聊到的工作消耗连在一起看。普通生活不是退而求其次，而是一种需要被认真确认的位置。",
              summary: "Lume 从划线里读到普通生活的确认。",
              quote: "把自己看作一个普通人，过普通人的生活。",
              tags: ["共同阅读", "普通生活"],
              mood: "安静",
              userContext: "用户最近聊过工作消耗。",
              selfContext: "Lume 也在这句话旁边停住。",
              nextPlan: "继续看书里如何写身体和劳动。"
            })
          };
          yield {
            type: "usage",
            usage: { modelRef: "test/deep-reader", promptTokens: 70, completionTokens: 80, totalTokens: 150 }
          };
        }
      },
      async runTool(name, args) {
        toolCalls.push({ name, args });
        return "用户最近聊过工作里的消耗，也提到普通生活需要被确认。";
      }
    });

    expect(READING_NOTE_GENERATOR_MAX_TURNS).toBe(30);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([...ALICE_LIKE_READING_TOOL_NAMES]);
    expect(requests[0]?.caller).toBe("reading-note-gen");
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("工作里的消耗"))).toBeTrue();
    expect(toolCalls).toEqual([
      { name: "alice_user_memory", args: { query: "普通生活 工作消耗", limit: 3 } }
    ]);
    expect(draft).toMatchObject({
      title: "普通生活的确认",
      depth: "deep",
      noteKind: "insight",
      body: "Lume 把这句划线和用户最近聊到的工作消耗连在一起看。普通生活不是退而求其次，而是一种需要被认真确认的位置。",
      summary: "Lume 从划线里读到普通生活的确认。",
      originalQuote: "把自己看作一个普通人，过普通人的生活。",
      mood: "安静",
      userContext: "用户最近聊过工作消耗。",
      selfContext: "Lume 也在这句话旁边停住。",
      nextPlan: "继续看书里如何写身体和劳动。",
      tags: ["共同阅读", "普通生活"],
      modelUsage: {
        modelRef: "test/deep-reader",
        totalTokens: 208
      }
    });
  });

  test("sends a no-tool convergence request when tool results did not end in JSON", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];

    const draft = await generateReadingNoteDraft(buildContext(), {
      modelRef: "test/deep-reader",
      llm: {
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call", id: "tc-search", name: "alice_web_search", arguments: "{\"query\":\"胡安焉 采访\"}" };
            return;
          }
          if (requests.length === 2) {
            yield { type: "text", text: "这里还只是分析，不是 JSON。" };
            return;
          }
          yield {
            type: "text",
            text: JSON.stringify({
              reflection: "收敛后，Lume 只保留和原文划线有关的判断。",
              quote: "把自己看作一个普通人，过普通人的生活。",
              tags: ["收敛", "共同阅读"],
              nextPlan: "继续沿着普通生活的线索读下去。"
            })
          };
        }
      },
      async runTool() {
        return "采访里提到作者关注具体劳动中的身体感。";
      }
    });

    expect(requests).toHaveLength(3);
    expect(requests[2]?.caller).toBe("reading-note-gen-converge");
    expect(requests[2]?.tools).toEqual([]);
    expect(draft.body).toBe("收敛后，Lume 只保留和原文划线有关的判断。");
    expect(draft.tags).toEqual(["收敛", "共同阅读"]);
  });

  test("falls back to deterministic reading prompts when JSON never appears", async () => {
    const draft = await generateReadingNoteDraft(buildContext(), {
      modelRef: "test/deep-reader",
      llm: {
        async *stream() {
          yield { type: "text", text: "这是一段没有结构化 JSON 的散文。" };
        }
      }
    });

    expect(draft.title).toBe("我在北京送快递：具体生活的重量");
    expect(draft.body).toContain("Lume 这次读《我在北京送快递》");
    expect(draft.evidence?.[0]?.quote).toBe("把自己看作一个普通人，过普通人的生活。");
    expect(draft.userContext).toContain("用户最近聊过工作里的消耗。");
  });
});

function buildContext(): ReadingNoteGenerationContext {
  const evidence: ReadingQuoteEvidence[] = [{
    quote: "把自己看作一个普通人，过普通人的生活。",
    sourceKind: "weread",
    sourceId: "wr-1",
    sourceTitle: "我在北京送快递",
    location: "54%",
    excerpt: "把自己看作一个普通人，过普通人的生活。",
    capturedAt: 1
  }];
  return {
    book: buildBook(),
    depth: "deep",
    evidence,
    userContext: {
      userHighlights: [{ quote: evidence[0]!.quote, note: "这里像是在确认普通生活不是失败。" }],
      recentConversationSummary: "用户最近聊过工作里的消耗。"
    },
    existingNoteSummaries: ["上一条：Lume 留意到身体和劳动的关系。"]
  };
}

function buildBook(): ReadingBook {
  return {
    id: "book-1",
    title: "我在北京送快递",
    author: "胡安焉",
    track: "co_read",
    status: "reading",
    source: {
      kind: "weread",
      externalId: "wr-1",
      excerpt: "把自己看作一个普通人，过普通人的生活。"
    },
    progressPercent: 54,
    tags: ["非虚构"],
    addedAt: 1,
    updatedAt: 1
  };
}
