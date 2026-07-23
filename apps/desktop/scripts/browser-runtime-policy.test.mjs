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

test("browser partitions keep user, Agent task, and advanced CDP sessions distinct", () => {
  assert.equal(selectBrowserSessionKind(user, {}), "user");
  assert.equal(selectBrowserPartition(user, {}), "persist:lume-browser");
  assert.equal(selectBrowserPartition(agent, {}), "lume-agent-task_1-turn_2");
  assert.equal(selectBrowserPartition(user, { sessionKind: "advanced-cdp" }), "lume-cdp-user-turn");
});

test("Agent policy is never selected for the persistent user partition", () => {
  assert.equal(shouldInstallAgentSessionPolicy("persist:lume-browser"), false);
  assert.equal(shouldInstallAgentSessionPolicy("lume-agent-task-turn"), true);
  assert.equal(shouldInstallAdvancedCdpPolicy("persist:lume-browser"), false);
  assert.equal(shouldInstallAdvancedCdpPolicy("lume-cdp-task-turn"), true);
});
