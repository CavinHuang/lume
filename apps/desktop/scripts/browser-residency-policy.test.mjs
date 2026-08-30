import assert from "node:assert/strict";
import test from "node:test";
import { isSuspendProtected } from "../src/browser-residency-policy.ts";

test("bare background tab without activity is not protected", () => {
  assert.equal(isSuspendProtected({}), false);
});

test("lease, handoff, in-flight agent action and pending dialog all protect the tab", () => {
  assert.equal(isSuspendProtected({ agentLease: { browserSessionId: "s", browserTurnId: "t", generation: 1 } }), true);
  assert.equal(isSuspendProtected({ handoff: { status: "handoff" } }), true);
  assert.equal(isSuspendProtected({ agentDispatching: true }), true);
  assert.equal(isSuspendProtected({ dialogOpen: true }), true);
});

test("loading tabs are protected so suspension cannot tear down an in-flight navigation", () => {
  assert.equal(isSuspendProtected({ isLoading: true }), true);
});

test("perceptible media states protect the tab", () => {
  assert.equal(isSuspendProtected({ mediaState: { audible: true } }), true);
  assert.equal(isSuspendProtected({ mediaState: { camera: true } }), true);
  assert.equal(isSuspendProtected({ mediaState: { microphone: true } }), true);
  assert.equal(isSuspendProtected({ mediaState: { audible: false, camera: false, microphone: false } }), false);
});
