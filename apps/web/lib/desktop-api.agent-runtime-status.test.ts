import { describe, expect, test } from "bun:test";
import {
  getAgentRuntimeStatus,
  onAgentRuntimeStatusChanged
} from "./desktop-api";

describe("desktop-api agent runtime status", () => {
  test("应暴露 getAgentRuntimeStatus", () => {
    expect(typeof getAgentRuntimeStatus).toBe("function");
  });

  test("应暴露 onAgentRuntimeStatusChanged", () => {
    expect(typeof onAgentRuntimeStatusChanged).toBe("function");
  });
});
