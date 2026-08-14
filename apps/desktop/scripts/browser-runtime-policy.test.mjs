import assert from "node:assert/strict";
import test from "node:test";
import {
  selectBrowserPartition,
  selectBrowserSessionKind,
  shouldInstallAgentSessionPolicy,
  shouldInstallAdvancedCdpPolicy,
} from "../src/browser-runtime-policy.ts";

const user = { browserSessionId: "user", browserTurnId: "turn", actor: "user" };
const agent = { browserSessionId: "task/1", browserTurnId: "turn/2", actor: "agent" };

test("user and Agent tabs share the persistent profile unless isolation is explicit", () => {
  assert.equal(selectBrowserSessionKind(user, {}), "shared");
  assert.equal(selectBrowserSessionKind(agent, {}), "shared");
  assert.equal(selectBrowserPartition(user, {}), "persist:lume-browser");
  assert.equal(selectBrowserPartition(agent, {}), "persist:lume-browser");
  assert.equal(selectBrowserSessionKind(agent, { sessionKind: "agent-task" }), "agent-task");
  assert.equal(selectBrowserPartition(agent, { sessionKind: "agent-task" }), "lume-agent-task_1-turn_2");
  assert.equal(selectBrowserPartition(user, { sessionKind: "advanced-cdp" }), "lume-cdp-user-turn");
});

test("Agent policy is never selected for the persistent user partition", () => {
  assert.equal(shouldInstallAgentSessionPolicy("persist:lume-browser"), false);
  assert.equal(shouldInstallAgentSessionPolicy("lume-agent-task-turn"), true);
  assert.equal(shouldInstallAdvancedCdpPolicy("persist:lume-browser"), false);
  assert.equal(shouldInstallAdvancedCdpPolicy("lume-cdp-task-turn"), true);
});
