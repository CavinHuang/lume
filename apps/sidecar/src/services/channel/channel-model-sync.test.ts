import { describe, expect, test } from "bun:test";
import type { ChannelModel } from "@lume/shared";
import { mergeSyncedModels } from "./channel-manager";

const model = (
  id: string,
  source: ChannelModel["source"],
  enabled = true,
): ChannelModel => ({ id, name: id, source, enabled });

describe("connection model sync", () => {
  test("enables new discoveries, removes missing discoveries, and preserves manual models", () => {
    const result = mergeSyncedModels(
      [
        model("removed", "discovered"),
        model("kept-disabled", "discovered", false),
        model("manual", "manual"),
      ],
      [
        model("kept-disabled", undefined),
        model("new", undefined, false),
      ],
      "openai",
    );

    expect(result.models.map(({ id, source, enabled }) => ({ id, source, enabled }))).toEqual([
      { id: "manual", source: "manual", enabled: true },
      { id: "kept-disabled", source: "discovered", enabled: false },
      { id: "new", source: "discovered", enabled: true },
    ]);
    expect(result).toMatchObject({ added: 1, removed: 1, preservedManual: 1 });
  });
});
