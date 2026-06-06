import { describe, expect, test } from "bun:test";
import type { ReadingBook, ReadingQuoteEvidence } from "@lume/shared";
import {
  ALICE_LIKE_READING_TOOL_NAMES,
  generateReadingNoteDraft,
  READING_NOTE_GENERATOR_MAX_TURNS,
  type ReadingNoteGeneratorStreamRequest
} from "./reading-note-generator";
import type { ReadingNoteGenerationContext } from "./reading-task-runner";

function unwrapDraft(result: Awaited<ReturnType<typeof generateReadingNoteDraft>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unexpected");
  return result.draft;
}

describe("reading-note-generator", () => {
  test("runs an Alice-like tool loop and turns final JSON into a note draft", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const draft = unwrapDraft(await generateReadingNoteDraft(buildContext(), {
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
    }));

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

  test("builds Alice-like deep reading prompts with quality checks and continuity", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];

    await generateReadingNoteDraft(buildContext(), {
      modelRef: "test/deep-reader",
      llm: {
        async *stream(request) {
          requests.push(request);
          yield {
            type: "text",
            text: JSON.stringify({
              title: "普通生活的确认",
              reflection: "服务业里最有张力的瞬间，常常发生在规则照不到的缝隙里。胡安焉这句话不是在安慰自己，而是在拒绝继续扮演系统里的完美服务者。",
              summary: "Lume 从划线里读到普通生活的确认。",
              quote: "把自己看作一个普通人，过普通人的生活。",
              tags: ["普通生活", "服务关系"],
              nextPlan: "继续看身体、劳动和关系如何展开。"
            })
          };
        }
      }
    });

    const firstRequest = requests[0];
    const systemPrompt = firstRequest?.messages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = firstRequest?.messages.find((message) => message.role === "user")?.content ?? "";

    expect(systemPrompt).toContain("知识增量");
    expect(systemPrompt).toContain("两层价值");
    expect(systemPrompt).toContain("被掠过的逻辑链条");
    expect(systemPrompt).toContain("真实交汇");
    expect(systemPrompt).toContain("先独立深读");
    expect(systemPrompt).toContain("跨领域佐证");
    expect(systemPrompt).toContain("骨架检验");
    expect(systemPrompt).toContain("浅层类比");
    expect(systemPrompt).toContain("不要硬凑");
    expect(systemPrompt).toContain("禁止编造");
    expect(systemPrompt).toContain("写作铁律");
    expect(systemPrompt).toContain("禁止「不是");
    expect(systemPrompt).toContain("禁止用破折号");
    expect(systemPrompt).toContain("第一段");
    expect(systemPrompt).toContain("JSON");
    expect(userPrompt).toContain("上次给自己留的线索");
    expect(userPrompt).toContain("nextPlan");
    expect(userPrompt).toContain("不要重复");
    expect(userPrompt).toContain("4 个自然段");
    expect(userPrompt).toContain("把自己看作一个普通人");
    expect(userPrompt).toContain("用户在这本书里的划线");
    expect(userPrompt).toContain("用户划线的段落是用户的关注点");
    expect(userPrompt).toContain("相关用户记忆");
    expect(userPrompt).toContain("用户关注工作消耗和日常尊严");
    expect(userPrompt).toContain("最近对话片段");
    expect(userPrompt).toContain("这句话让我想到自己的工作状态");
    expect(userPrompt).toContain("Lume 最近读书记录");
    expect(userPrompt).toContain("上一条笔记已经写过身体和劳动");
    expect(userPrompt).toContain("已经引用过的句子");
  });

  test("uses Alice-like lightweight seed prompts without tools", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];

    await generateReadingNoteDraft({ ...buildContext(), depth: "seed" }, {
      modelRef: "test/seed-reader",
      llm: {
        async *stream(request) {
          requests.push(request);
          yield {
            type: "text",
            text: JSON.stringify({
              quote: "把自己看作一个普通人，过普通人的生活。",
              reflection: "Lume 先把这句话记下来。它像一个入口，提醒自己之后继续看普通生活和身体经验之间的关系。",
              tags: ["普通生活", "入口"],
              mood: "安静",
              nextPlan: "继续看普通生活怎样被具体劳动改变。"
            })
          };
        }
      }
    });

    const firstRequest = requests[0];
    const systemPrompt = firstRequest?.messages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = firstRequest?.messages.find((message) => message.role === "user")?.content ?? "";

    expect(firstRequest?.tools).toEqual([]);
    expect(systemPrompt).toContain("简短读书笔记");
    expect(systemPrompt).toContain("像写给自己的随手感悟");
    expect(systemPrompt).not.toContain("两层价值");
    expect(userPrompt).toContain("200-350字");
    expect(userPrompt).toContain("2-4 个自然段");
    expect(userPrompt).toContain("绝对禁止引用或暗示你还没读到的后续章节内容");
  });

  test("sends a no-tool convergence request when tool results did not end in JSON", async () => {
    const requests: ReadingNoteGeneratorStreamRequest[] = [];

    const draft = unwrapDraft(await generateReadingNoteDraft(buildContext(), {
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
    }));

    expect(requests).toHaveLength(3);
    expect(requests[2]?.caller).toBe("reading-note-gen-converge");
    expect(requests[2]?.tools).toEqual([]);
    expect(draft.body).toBe("收敛后，Lume 只保留和原文划线有关的判断。");
    expect(draft.tags).toEqual(["收敛", "共同阅读"]);
  });

  test("returns failure when LLM never produces valid JSON", async () => {
    const result = await generateReadingNoteDraft(buildContext(), {
      modelRef: "test/deep-reader",
      llm: {
        async *stream() {
          yield { type: "text", text: "这是一段没有结构化 JSON 的散文。" };
        }
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeDefined();
    }
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
      recentConversationSummary: "用户最近聊过工作里的消耗。",
      memorySnippets: ["用户关注工作消耗和日常尊严。"],
      recentConversationSnippets: ["用户：这句话让我想到自己的工作状态。"],
      recentReadingNoteSnippets: ["《我在北京送快递》普通生活的确认 / 上一条笔记已经写过身体和劳动。"]
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
