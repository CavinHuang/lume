import { describe, expect, test } from "bun:test";
import {
  channelIdParamsSchema,
  connectionIdParamsSchema,
  oauthAnswerParamsSchema,
  oauthCancelParamsSchema,
  oauthSessionIdParamsSchema
} from "./schemas";

describe("channel RPC param schemas", () => {
  test("channelIdParamsSchema accepts a non-empty channelId", () => {
    expect(channelIdParamsSchema.parse({ channelId: "ch-1" })).toEqual({ channelId: "ch-1" });
  });

  test("channelIdParamsSchema rejects missing and empty channelId", () => {
    expect(channelIdParamsSchema.safeParse({}).success).toBe(false);
    expect(channelIdParamsSchema.safeParse({ channelId: "" }).success).toBe(false);
    expect(channelIdParamsSchema.safeParse({ channelId: 42 }).success).toBe(false);
  });

  test("param schemas reject unknown keys like the sibling channel schemas", () => {
    expect(channelIdParamsSchema.safeParse({ channelId: "ch-1", extra: true }).success).toBe(false);
    expect(connectionIdParamsSchema.safeParse({ connectionId: "conn-1", channelId: "x" }).success).toBe(false);
  });

  test("oauthSessionIdParamsSchema requires a non-empty sessionId", () => {
    expect(oauthSessionIdParamsSchema.parse({ sessionId: "s-1" }).sessionId).toBe("s-1");
    expect(oauthSessionIdParamsSchema.safeParse({ sessionId: "" }).success).toBe(false);
  });

  test("oauthAnswerParamsSchema keeps value optional and ids required", () => {
    expect(oauthAnswerParamsSchema.parse({ sessionId: "s-1", promptId: "p-1" }).value).toBeUndefined();
    expect(oauthAnswerParamsSchema.parse({ sessionId: "s-1", promptId: "p-1", value: "yes" }).value).toBe("yes");
    expect(oauthAnswerParamsSchema.safeParse({ sessionId: "s-1" }).success).toBe(false);
  });

  test("oauthCancelParamsSchema tolerates an absent sessionId (legacy no-op face)", () => {
    expect(oauthCancelParamsSchema.parse({})).toEqual({});
    expect(oauthCancelParamsSchema.parse({ sessionId: "s-1" }).sessionId).toBe("s-1");
    expect(oauthCancelParamsSchema.safeParse({ sessionId: "" }).success).toBe(false);
  });
});
