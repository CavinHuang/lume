import assert from "node:assert/strict";
import test from "node:test";
import { canAgentClaim, canAgentUse, revokeSharedLease } from "../src/browser-sharing-policy.ts";

test("unshared tabs cannot be claimed, explicit claim permits concurrent use, and revocation invalidates it", () => {
  const tab = { partition: "persist:lume-browser", shareable: false };
  assert.equal(canAgentClaim(tab, "s", "t"), false);
  tab.shareable = true;
  tab.agentLease = { browserSessionId: "s", browserTurnId: "t", generation: 3 };
  assert.equal(canAgentUse(tab, "s", "t", 3), true);
  assert.equal(canAgentUse(tab, "other", "t", 3), false);
  revokeSharedLease(tab);
  assert.equal(canAgentUse(tab, "s", "t", 3), false);
});

test("a concurrent user input changes the generation and makes the old target stale", () => {
  const tab = { partition: "persist:lume-browser", shareable: true, agentLease: { browserSessionId: "s", browserTurnId: "t", generation: 2 } };
  tab.agentLease = { ...tab.agentLease, generation: 3 };
  assert.equal(canAgentUse(tab, "s", "t", 2), false);
  assert.equal(canAgentUse(tab, "s", "t", 3), true);
});
