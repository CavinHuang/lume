import assert from "node:assert/strict";
import test from "node:test";
import { canAgentClaim, canAgentResumeHandoff, canAgentUse, revokeSharedLease } from "../src/browser-sharing-policy.ts";

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

test("resume skips tabs paused by user takeover even though they carry a handoff marker", () => {
  const handoffTab = { handoff: { browserSessionId: "s", status: "handoff" }, agentControlState: "active" };
  assert.equal(canAgentResumeHandoff(handoffTab, "s"), true);
  // pauseAgentControl 给被接管 tab 复用的正是 handoff 标记：不过滤 paused_by_user
  // 时 agent 可借恢复路径单方面撤销接管
  assert.equal(canAgentResumeHandoff({ ...handoffTab, agentControlState: "paused_by_user" }, "s"), false);
  assert.equal(canAgentResumeHandoff(handoffTab, "other-session"), false);
  assert.equal(canAgentResumeHandoff({ handoff: { browserSessionId: "s", status: "released" }, agentControlState: "active" }, "s"), false);
  assert.equal(canAgentResumeHandoff({ agentControlState: "active" }, "s"), false);
});
