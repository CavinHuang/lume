import { describe, expect, test } from "bun:test";
import {
  getAgentThreadRuntimeStatus,
  getAgentThreadSDKMessages,
  onAgentMessageAppended,
  updateAgentThreadModelSelection,
  onAgentRuntimeStatusChanged
} from "./desktop-api";

describe("desktop-api agent runtime status", () => {
  test("应暴露 getAgentThreadRuntimeStatus", () => {
    expect(typeof getAgentThreadRuntimeStatus).toBe("function");
  });

  test("应暴露 onAgentRuntimeStatusChanged", () => {
    expect(typeof onAgentRuntimeStatusChanged).toBe("function");
  });

  test("应暴露 updateAgentThreadModelSelection", () => {
    expect(typeof updateAgentThreadModelSelection).toBe("function");
  });

  test("应暴露 onAgentMessageAppended", () => {
    expect(typeof onAgentMessageAppended).toBe("function");
  });

  test("应暴露 getAgentThreadSDKMessages", () => {
    expect(typeof getAgentThreadSDKMessages).toBe("function");
  });
});
