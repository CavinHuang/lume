import { describe, expect, it } from "bun:test";
import { getConnector } from "../../../connectors/service";
import { CONNECTOR_TOOL_CONFIGS } from "./create-connector-tools";

/** 变更类动词:命中即必须可触发审批(isReadOnly=false)。 */
const MUTATING_VERB = /(^|_)(send|reply|forward|delete|move|create|modify|mark|trash|add|remove|update|set|insert|archive|untrash|watch)($|_)/;

describe("connector tool read-only mapping", () => {
  it("only marks actions that exist in the provider catalog (typo guard)", () => {
    for (const config of CONNECTOR_TOOL_CONFIGS) {
      const catalog = new Set(getConnector(config.service).definition.actions.map((action) => action.name));
      for (const name of config.readOnlyActions) {
        expect(catalog.has(name)).toBe(true);
      }
    }
  });

  // isReadOnly 直接驱动人工审批门:一个 typo 让 move_to_trash 之类的动作
  // 落进只读集合,就会静默跳过用户确认。此不变式失败时先怀疑手滑,再考虑
  // 扩展 MUTATING_VERB 词表。
  it("never marks mutating actions as read-only (approval gate invariant)", () => {
    for (const config of CONNECTOR_TOOL_CONFIGS) {
      const mutating = getConnector(config.service)
        .definition.actions.map((action) => action.name)
        .filter((name) => MUTATING_VERB.test(name));
      const leaked = mutating.filter((name) => config.readOnlyActions.has(name));
      expect(leaked).toEqual([]);
    }
  });
});
