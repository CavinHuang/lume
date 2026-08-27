import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  listToolPermissionGrantsInputSchema,
  revokeToolPermissionGrantInputSchema,
} from "./schemas";

describe("tool permission grants RPC (#775)", () => {
  test("通道常量存在", () => {
    expect(AGENT_IPC_CHANNELS.LIST_TOOL_PERMISSION_GRANTS).toBe("agent:list-tool-permission-grants");
    expect(AGENT_IPC_CHANNELS.REVOKE_TOOL_PERMISSION_GRANT).toBe("agent:revoke-tool-permission-grant");
  });

  test("列表入参为空对象即可", () => {
    expect(listToolPermissionGrantsInputSchema.parse({})).toEqual({});
    // 仓内 schema 约定：未知键 strip（见 submitToolPermissionInputSchema 注释），不抛错
    expect(listToolPermissionGrantsInputSchema.parse({ threadId: 1 })).toEqual({});
  });

  test("撤销入参要求 ids 或 workspace 至少其一", () => {
    expect(revokeToolPermissionGrantInputSchema.safeParse({ ids: ["abc"] }).success).toBeTrue();
    expect(revokeToolPermissionGrantInputSchema.safeParse({ workspaceSlug: "ws-a" }).success).toBeTrue();
    expect(revokeToolPermissionGrantInputSchema.safeParse({}).success).toBeFalse();
    expect(revokeToolPermissionGrantInputSchema.safeParse({ ids: [] }).success).toBeFalse();
  });
});
