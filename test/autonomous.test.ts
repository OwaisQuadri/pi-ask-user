import assert from "node:assert/strict";
import { test } from "node:test";
import { guidanceForContinuation, guidanceForQuestion, isAutonomousScope, type AutonomousApproval } from "../src/autonomous.ts";

const approval: AutonomousApproval = {
	approvalId: "approval-1", sessionId: "owner", approvedAt: "2026-01-01T00:00:00Z",
	provenance: "interactive-user", expiresOn: "task_complete", expiresAt: "2026-01-02T00:00:00Z",
	taskId: "task-1", scope: "Update the picker", principleSources: ["docs/principles.md"],
	protectedActions: [{ action: "publish", target: "draft-pr", bounds: "draft only" }],
	preparation: { decisions: ["Update the picker only"], credentials: [], accessChecks: ["No credentials required"] },
};
const policy = { taskId: approval.taskId, scope: approval.scope, kind: "routine", isReversible: true };
const now = Date.parse("2026-01-01T01:00:00Z");

test("question and continuation guidance retain provenance and boundaries without copying decision policy", () => {
	const question = guidanceForQuestion(approval, "owner", policy, false, now)!;
	assert.equal(question.outcome, "guidance");
	for (const result of [question.text, guidanceForContinuation(approval)]) {
		assert.match(result, /AUTOMATIC POLICY GUIDANCE/);
		assert.match(result, /not a human answer, selected option, or new approval/);
		assert.match(result, /Approval ID: approval-1/);
		assert.match(result, /interactive user in this session only/);
		assert.match(result, /Owning session: owner\. Approval provenance: interactive-user/);
		assert.match(result, /Task: task-1\. Scope: Update the picker/);
		assert.ok(result.includes(approval.expiresAt));
		assert.match(result, /docs\/principles.md/);
		assert.match(result, /personal precedence as defined by those owners/);
		assert.ok(result.includes(JSON.stringify(approval.protectedActions)));
		assert.match(result, /not execution authorization or a sandbox/);
		assert.match(result, /Credential controls, native permission prompts, command guards, and human-only merges/);
		assert.match(result, /task_complete and taskId "task-1"/);
		assert.match(result, /Revocation is not task completion/);
		assert.doesNotMatch(result, /Resolve routine reversible decisions|fresh-context|heartbeat|night-time/);
	}
});

test("active autonomy defers secure, approval, information and unmatched protected questions instead of asking", () => {
	const protectedPolicy = { ...policy, kind: "protected", protectedAction: { ...approval.protectedActions[0], bounds: "wider" } };
	for (const [metadata, isSecure] of [
		[policy, true], [{ ...policy, kind: "approval" }, false], [{ ...policy, kind: "information" }, false], [protectedPolicy, false],
	] as const) {
		const result = guidanceForQuestion(approval, "owner", metadata, isSecure, now)!;
		assert.equal(result.outcome, "deferred");
		assert.match(result.text, /DEFERRED TO USER: No human was asked and no dialog opened/);
		assert.match(result.text, /Do not perform the requested action or assume an answer/);
	}
});

test("other sessions, expired approval and inactive autonomy receive no automatic reply", () => {
	assert.equal(guidanceForQuestion(approval, "child", policy, false, now), undefined);
	assert.equal(guidanceForQuestion(approval, "owner", policy, false, Date.parse(approval.expiresAt)), undefined);
	assert.equal(guidanceForQuestion(undefined, "owner", policy, false, now), undefined);
});

test("missing or mismatched task metadata returns AI routing errors rather than asking the human", () => {
	for (const metadata of [undefined, { ...policy, scope: "Another task" }, { ...policy, taskId: "another" }, { ...policy, isReversible: false }]) {
		const result = guidanceForQuestion(approval, "owner", metadata, false, now)!;
		assert.equal(result.outcome, "routing-error");
		assert.match(result.text, /AI ROUTING ERROR: No human was asked/);
		assert.match(result.text, /Never guess consent/);
	}
});

test("protected guidance requires exact action, target and bounds from the approved record", () => {
	const protectedPolicy = { ...policy, kind: "protected", protectedAction: approval.protectedActions[0] };
	assert.match(guidanceForQuestion(approval, "owner", protectedPolicy, false, now)!.text, /grants no new authority/);
	for (const field of ["action", "target", "bounds"]) {
		assert.equal(guidanceForQuestion(approval, "owner", {
			...protectedPolicy, protectedAction: { ...protectedPolicy.protectedAction, [field]: "wider" },
		}, false, now)!.outcome, "deferred");
	}
});

test("approval scope requires explicit principle references and finite expiry", () => {
	assert.equal(isAutonomousScope(approval), true);
	assert.equal(isAutonomousScope({ ...approval, principleSources: [] }), false);
	assert.equal(isAutonomousScope({ ...approval, expiresAt: "forever" }), false);
	assert.equal(isAutonomousScope({ ...approval, protectedActions: [{ action: "publish" }] }), false);
});
