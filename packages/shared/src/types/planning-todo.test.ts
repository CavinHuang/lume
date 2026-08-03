import { describe, expect, test } from "bun:test";
import { createPlanningOperation, reducePlanningOperation } from "./planning-todo";

describe("Planning Todo operation reducer", () => {
  test("only advances a start operation through persisted phases", () => {
    const reserved = createPlanningOperation({ operationId: "op-1", kind: "start" });
    const created = reducePlanningOperation(reserved, { phase: "thread_created", threadId: "thread-1" });
    expect(created.phase).toBe("thread_created");
    expect(() => reducePlanningOperation(created, { phase: "reserved" })).toThrow();
    const finalized = reducePlanningOperation(created, { phase: "finalized", status: "completed", recoverable: false });
    expect(finalized.status).toBe("completed");
    expect(() => reducePlanningOperation(finalized, { phase: "link_committed" })).toThrow();
  });
});
