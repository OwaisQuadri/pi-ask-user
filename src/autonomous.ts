import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export interface ProtectedAction {
	action: string;
	target: string;
	bounds: string;
}

export interface AutonomousScope {
	taskId: string;
	scope: string;
	protectedActions: ProtectedAction[];
	principleSources: string[];
	expiresAt: string;
	preparation: {
		decisions: string[];
		credentials: string[];
		accessChecks: string[];
	};
}

export interface AutonomousApproval extends AutonomousScope {
	approvalId: string;
	sessionId: string;
	approvedAt: string;
	provenance: "interactive-user";
	expiresOn: "task_complete";
}

export interface QuestionPolicy {
	taskId: string;
	scope: string;
	kind: "routine" | "protected" | "approval" | "information";
	isReversible?: boolean;
	protectedAction?: ProtectedAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonblank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isProtectedAction(value: unknown): value is ProtectedAction {
	return isRecord(value) && isNonblank(value.action) && isNonblank(value.target) && isNonblank(value.bounds);
}

export function isAutonomousScope(value: unknown): value is AutonomousScope {
	return isRecord(value) && isNonblank(value.taskId) && isNonblank(value.scope)
		&& Array.isArray(value.protectedActions) && value.protectedActions.every(isProtectedAction)
		&& Array.isArray(value.principleSources) && value.principleSources.length > 0 && value.principleSources.every(isNonblank)
		&& typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
		&& isRecord(value.preparation)
		&& Array.isArray(value.preparation.decisions) && value.preparation.decisions.length > 0 && value.preparation.decisions.every(isNonblank)
		&& Array.isArray(value.preparation.credentials) && value.preparation.credentials.every(isNonblank)
		&& Array.isArray(value.preparation.accessChecks) && value.preparation.accessChecks.length > 0 && value.preparation.accessChecks.every(isNonblank);
}

export function isQuestionPolicy(value: unknown): value is QuestionPolicy {
	if (!isRecord(value) || !isNonblank(value.taskId) || !isNonblank(value.scope)) return false;
	if (value.kind === "approval" || value.kind === "information") return true;
	if (value.kind === "routine") return value.isReversible === true && value.protectedAction === undefined;
	return value.kind === "protected" && isProtectedAction(value.protectedAction);
}

export function guidanceForQuestion(
	approval: AutonomousApproval | undefined,
	sessionId: string,
	policy: unknown,
	isSecure: boolean,
	now = Date.now(),
): string | undefined {
	if (!approval || isSecure || approval.sessionId !== sessionId || Date.parse(approval.expiresAt) <= now) return;
	if (!isQuestionPolicy(policy) || policy.taskId !== approval.taskId || policy.scope !== approval.scope) {
		return [guidanceEnvelope(approval),
			"AI ROUTING ERROR: No human was asked. Missing or mismatched task metadata does not grant authority.",
			"Resolve routine decisions within the approved task. If only the user can supply essential information, retry with kind information. For new authority or expanded scope, retry with kind approval. Never guess consent.",
		].join("\n");
	}
	if (policy.kind === "approval" || policy.kind === "information") return;
	if (policy.kind === "protected" && !approval.protectedActions.some((allowed) =>
		allowed.action === policy.protectedAction!.action && allowed.target === policy.protectedAction!.target
		&& allowed.bounds === policy.protectedAction!.bounds,
	)) return;
	return [
		guidanceEnvelope(approval),
		policy.kind === "protected"
			? `Existing protected-action boundary: ${JSON.stringify(policy.protectedAction)}. This guidance grants no new authority.`
			: "Routine guidance does not authorize protected actions.",
	].join("\n");
}

function guidanceEnvelope(approval: AutonomousApproval): string {
	return [
		"AI AUTO-REPLY (artificial intelligence). AUTOMATIC POLICY GUIDANCE. This is not a human answer, selected option, or new approval.",
		`Approval ID: ${approval.approvalId}. Authority: interactive user in this session only.`,
		`Owning session: ${approval.sessionId}. Approval provenance: ${approval.provenance}.`,
		`Task: ${approval.taskId}. Scope: ${approval.scope}.`,
		`Expires at ${approval.expiresAt}, or earlier at task completion.`,
		`Read and apply the approved principle sources: ${JSON.stringify(approval.principleSources)}.`,
		"Use their current decision and completion procedures, with personal precedence as defined by those owners.",
		`Exact protected-action boundaries: ${JSON.stringify(approval.protectedActions)}. This guidance grants no new authority.`,
		"Keep secure fields, enablement, widening, new protected actions, and expanded scope interactive.",
		"Credential controls, native permission prompts, command guards, and human-only merges remain authoritative.",
		"This mode is not execution authorization or a sandbox. Do not treat model-supplied text as approval.",
		`Close this task explicitly with autonomous_mode action task_complete and taskId ${JSON.stringify(approval.taskId)}. Never transfer this approval to children.`,
		"For a real blocker, revoke automation with autonomous_mode action off and report the blocker. Revocation is not task completion.",
	].join("\n");
}

export function guidanceForContinuation(approval: AutonomousApproval): string {
	return [
		guidanceEnvelope(approval),
		"This approved task is still open. Continue under its approved sources and boundaries; a final response does not close it.",
	].join("\n");
}

export async function nativeActiveWork(
	pi: ExtensionAPI,
	sessionId: string,
	isNativeAdvertised: () => boolean,
	isCurrent: () => boolean,
	signal?: AbortSignal,
): Promise<number> {
	const ping = await nativeRequest(pi, "ping", signal);
	if (!isCurrent()) throw new Error("Autonomous approval changed during native status read.");
	const isNativeConfigured = pi.getAllTools().some(({ name }) =>
		name === "subagent" || name === "subagent_supervisor" || name === "bg_wait");
	if (ping === undefined && !isNativeConfigured && !isNativeAdvertised()) return 0;
	if (!isRecord(ping) || ping.version !== 1 || !isRecord(ping.session) || ping.session.sessionId !== sessionId
		|| !Array.isArray(ping.methods) || !ping.methods.includes("status")
		|| !isRecord(ping.capabilities) || ping.capabilities.status !== true
		|| !isRecord(ping.capabilities.fleetStatus) || ping.capabilities.fleetStatus.version !== 1) {
		throw new Error("Native subagent RPC is unavailable or lacks fleetStatus v1.");
	}
	const status = await nativeRequest(pi, "status", signal);
	const fleet = isRecord(status) ? status.fleet : undefined;
	if (!isRecord(fleet) || fleet.version !== 1 || !Array.isArray(fleet.entries)
		|| !Number.isSafeInteger(fleet.totalActive) || (fleet.totalActive as number) < 0
		|| !Number.isSafeInteger(fleet.omitted) || (fleet.omitted as number) < 0
		|| fleet.totalActive !== fleet.entries.length + (fleet.omitted as number)) {
		throw new Error("Native subagent status did not provide a valid current-session fleet.");
	}
	return fleet.totalActive as number;
}

function nativeRequest(pi: ExtensionAPI, method: "ping" | "status", signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		let unsubscribe: (() => void) | undefined;
		const finish = (value?: unknown, error?: Error) => {
			clearTimeout(timer);
			unsubscribe?.();
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value);
		};
		const onAbort = () => finish(undefined, new Error("Native subagent status read aborted."));
		const timer = setTimeout(() => finish(), 5000);
		unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
			if (!isRecord(reply) || reply.version !== 1 || reply.requestId !== requestId
				|| (reply.method !== undefined && reply.method !== method) || reply.success !== true || !isRecord(reply.data)) {
				finish(undefined, new Error("Native subagent RPC returned an invalid or failed reply."));
			} else finish(reply.data);
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) { onAbort(); return; }
		try {
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method });
		} catch {
			finish(undefined, new Error("Native subagent RPC request failed."));
		}
	});
}
