import assert from "node:assert/strict";
import { test } from "node:test";
import { guidanceForQuestion, isAutonomousScope, type AutonomousApproval } from "../src/autonomous.ts";

const approval: AutonomousApproval = {
	approvalId: "approval-1", sessionId: "owner", approvedAt: "2026-01-01T00:00:00Z",
	provenance: "interactive-user", expiresOn: "task_complete", expiresAt: "2026-01-02T00:00:00Z",
	taskId: "task-1", scope: "Update the picker", principleSources: ["docs/principles.md"],
	protectedActions: [{ action: "publish", target: "draft-pr", bounds: "draft only" }],
};
const policy = { taskId: approval.taskId, scope: approval.scope, kind: "routine", isReversible: true };
const now = Date.parse("2026-01-01T01:00:00Z");

test("guidance never impersonates an answer or grants execution authority", () => {
	const result = guidanceForQuestion(approval, "owner", policy, false, now)!;
	assert.match(result, /AUTOMATIC POLICY GUIDANCE/);
	assert.match(result, /not a human answer, selected option, or new approval/);
	assert.match(result, /Approval ID: approval-1/);
	assert.match(result, /docs\/principles.md/);
	assert.match(result, /not execution authorization or a sandbox/);
});

test("secure, ambiguous, expanded, expired and child questions never receive automatic guidance", () => {
	for (const [sessionId, metadata, isSecure, time] of [
		["owner", policy, true, now], ["child", policy, false, now],
		["owner", undefined, false, now], ["owner", { ...policy, kind: "approval" }, false, now],
		["owner", { ...policy, scope: "Another task" }, false, now],
		["owner", { ...policy, taskId: "another" }, false, now],
		["owner", { ...policy, isReversible: false }, false, now],
		["owner", policy, false, Date.parse(approval.expiresAt)],
	] as const) assert.equal(guidanceForQuestion(approval, sessionId, metadata, isSecure, time), undefined);
	assert.equal(guidanceForQuestion(undefined, "owner", policy, false, now), undefined);
});

test("protected guidance requires exact action, target and bounds from the approved record", () => {
	const protectedPolicy = { ...policy, kind: "protected", protectedAction: approval.protectedActions[0] };
	assert.match(guidanceForQuestion(approval, "owner", protectedPolicy, false, now)!, /grants no new authority/);
	for (const field of ["action", "target", "bounds"]) {
		assert.equal(guidanceForQuestion(approval, "owner", {
			...protectedPolicy, protectedAction: { ...protectedPolicy.protectedAction, [field]: "wider" },
		}, false, now), undefined);
	}
});

test("approval scope requires explicit principle references and finite expiry", () => {
	assert.equal(isAutonomousScope(approval), true);
	assert.equal(isAutonomousScope({ ...approval, principleSources: [] }), false);
	assert.equal(isAutonomousScope({ ...approval, expiresAt: "forever" }), false);
	assert.equal(isAutonomousScope({ ...approval, protectedActions: [{ action: "publish" }] }), false);
});
