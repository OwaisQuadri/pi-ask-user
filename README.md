# pi-ask-user

A Pi extension with interactive questions and session-scoped autonomous policy guidance.

## What it does

- **Three answer modes.** Pick one option, pick several (`multiSelect: true`), or type free text when no options are given.
- **Other is always available.** Every option list has an Other choice, so you are never stuck with the agent's options.
- **Recommended first.** The agent puts its recommended option first and marks it.
- **Clipboard paste.** Paste text or an image into a free-text answer.
- **Subagent routing.** A child session's question goes to the main interactive session through Pi's event bus. One question shows at a time, and the others wait in a queue.
- **Secure field.** With `secure: true`, the agent gets a handle such as `{{secret:3f9a01bc}}`, never the value. In the terminal interface, the value shows as you type, and Ctrl+T masks it; RPC mode has no mask. Later tool results and messages sent to the model show the handle in place of any value of 8 or more characters. The extension emits `ask-user-question:secret` with `{ handle, value }` on Pi's in-process event bus, so another extension, such as pi-credentials, can use or save it. Handles last until Pi exits.
- **Herdr status.** The extension emits `herdr:blocked` while it waits for you, so your workspace shows that the agent needs you.

## Install

Install from this repository's Git URL:

```sh
pi install git:<this repository URL without https://>
```

## Tool parameters

| Parameter | Type | Purpose |
|---|---|---|
| `question` | string | The single question. Ask one question per call. |
| `details` | string, optional | Context shown under the question. |
| `options` | array, optional | `{ label, value?, description? }`. Omit for free text. |
| `multiSelect` | boolean, optional | Allow more than one answer. |
| `secure` | boolean, optional | Collect a secret. Free text only. Returns a handle, not the value. |
| `policy` | object, optional | Exact task metadata for autonomous guidance. Omit for an interactive question. |

## Autonomous policy guidance

Use `/autonomous on`, `/autonomous off`, or `/autonomous status` in the owning terminal session. Tab completes the subcommands.

The `autonomous_mode` tool accepts `action: "on"`, `"off"`, `"status"`, or `"task_complete"`.
An `on` request can include a proposed `scope` object. Proposals never grant authority.
Both the command and the tool open the host editor for scope review, then a separate human confirmation.
Enablement and every replacement or widening require this interaction, even when the mode is already active.
Cancellation preserves the previous approval.

The reviewed scope contains:

| Field | Purpose |
|---|---|
| `taskId` | The exact task identifier. |
| `scope` | The exact task boundary. |
| `protectedActions` | Exact `{ action, target, bounds }` tuples. Use an empty array for no protected-action guidance. |
| `principleSources` | Existing readable owner file paths. Relative paths resolve from the owning session's working directory. |
| `expiresAt` | A future date-time, preferably ISO 8601. The human reviews this finite expiry. |

Keep the scope nonsecret. Reference existing principle files instead of copying personal policies into the scope or extension.
The extension verifies that the files exist and are readable. Guidance tells the agent to read them before deciding.
It does not copy their text, interpret their policies, or use a separate decision service.
Supply the existing personal `AGENTS.md`, `ostack-o-mode`, and live pstack `poteto-mode` plus `playbooks/autonomous-run.md` references for human review.
Those owners define decision policy and personal precedence. This package does not keep another policy file.

An approval record lives only in extension memory. It includes the reviewed scope, session ID, approval ID, timestamp, and `interactive-user` provenance.
It is not restored from conversation history or inherited by another session.
Switching, forking, navigating the conversation tree, shutdown, or reload clears it.

The host has no task-completion event. Close the task explicitly with `autonomous_mode` and `{ "action": "task_complete", "taskId": "the-approved-task-id" }`.
`/autonomous off` also revokes approval. For a real blocker, use `autonomous_mode` with `action: "off"` and report the blocker, not task completion.
The time bound expires even if the caller omits task completion.
A normal agent turn ending does not imply task completion.

### Open-task continuation

Autonomous mode requires Pi 0.87.0 or later for its public `agent_before_settle` boundary.
Active approval marks this session's task as open until matching `task_complete`, revocation, or expiry.
After a completed response, the extension adds one labelled custom guidance entry and requests continuation when no other continuation, pending input, or live native subagent work owns the next step.
The entry uses the same approved principle references and safety envelope as question guidance. It is not a synthetic user answer.
It does not use global workspace allocations or add another task tracker.

Waiting for native subagents is allowed. The extension reads current-session status through the documented pi-subagents event-bus RPC(remote procedure call).
It checks the ping capabilities and the versioned fleet response, including `totalActive` and omitted entries.
Native completion wakes and bounded supervisor reminders keep their own ownership. This extension adds no polling, heartbeat, or wake subscription.
It does not restart user aborts or provider errors. Native exhausted-reminder entries revoke automation and report a blocker without marking the task complete.
A passive settlement observer handles those entries even when the native hook runs later.

Pi-subagents is not a required dependency. Absence requires a bounded ping with no responder, no native tools in Pi's configured tool registry, no ready advertisement, and no unresolved native notice.
With evidence of native integration, missing RPC, unsupported capabilities, malformed replies, or a status timeout are compatibility blockers, not an empty queue.
Each RPC request has a five-second limit and no retry. A blocker revokes approval with an explicit diagnostic; it never closes the task.
Approval, session identity, pending input, and abort state are checked again after asynchronous reads.
Status reads are observational, not an atomic transaction with another extension's completion wake.

### Question matching

To request guidance for a routine reversible decision, supply metadata like this:

```json
{
  "question": "Which local implementation fits this task?",
  "policy": {
    "taskId": "picker-update",
    "scope": "Update the picker layout",
    "kind": "routine",
    "isReversible": true
  }
}
```

The `taskId` and `scope` must exactly match the human-reviewed record.
For protected-action guidance, use `kind: "protected"` and a `protectedAction` with an exact approved `action`, `target`, and `bounds`.
Matching uses string equality, without wildcard expansion, semantic inference, or numeric range interpretation.
Use `kind: "approval"` for enablement, widening, or any request for new authority.
Metadata classifies a question; it cannot grant authority or amend the approved record.

A matching nonsecure question returns **AUTOMATIC POLICY GUIDANCE** with scope, principle references, authority limits, and the approval ID.
Its details use `status: "policy-guidance"`, `provenance: "automatic-policy-guidance"`, and an empty `answers` array.
The agent resolves the routine decision within that guidance. The reply is never a human answer, selected option, or new approval.
Human answers use `provenance: "interactive-user"`.

Secure fields always remain interactive. Unclassified, ambiguous, irreversible routine, expired, expanded-scope, and unmatched protected questions remain interactive.
Child RPC questions always remain interactive in the owning session, even if they include matching metadata.
RPC and child instances cannot enable the mode or receive the owning session's approval.
Use the owning terminal session explicitly for approval; this extension does not infer ownership from `hasUI` alone.

### Authority limits

This mode is not execution authorization or a sandbox.
Credential controls, native permission prompts, command guards, and human-only merges remain authoritative.
Even an exact protected-action match only provides guidance about an existing boundary.
It never approves execution or bypasses another control.
Model-supplied text cannot create an approval.

## Test

```sh
npm test
```

## License

MIT
