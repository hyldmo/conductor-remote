# Workflow orchestration review: prompting and iteration

Date: 2026-09-05. Written from the planning root of Workflow run `9057bf00` in this
repository. Reviewed against worktree commit `4b62235` plus the upstream diff to
`origin/main` at `b187b4d`. No review skills were used. Evidence comes from the source,
the relay's orchestration database, Conductor's database, and the one live run this
review ran inside.

## Short version

The prompting commits every run to one shape: explore, then implement, then review. The
mechanics make each child a single question with a single answer. Those two facts are
where iteration is lost.

The recommendations are ordered by value. Items 1 to 3, 9 and 10 are relay changes and are
implemented locally in this worktree. Items 4 and 5 are prompt wording and wait for the owner's
read. Items 6 to 8 are design changes for later.

| Item | Kind | Status |
|---|---|---|
| 1. Deliver the complete child reply with every Baton | relay | implemented locally |
| 2. Tell the root and the phone when a run blocks | relay | implemented locally |
| 3. Classify a post-apply verification mismatch as deterministic | relay | implemented locally |
| 4. Tell the root the mechanics it depends on | prompt | waits for the owner's read |
| 5. Loosen the child prompts and preambles | prompt | waits for the owner's read |
| 6. Let the objective decide the shape | design | later |
| 7. Follow-up delegation into an existing child chat | design | later |
| 8. Cap or scope the handoff | design | later |
| 9. Render relay error objects in the MCP client | relay | implemented locally |
| 10. Do not block a run on a transient compatibility read | relay | implemented locally |
| Shared model matcher for Workflow receipts | relay | shipped upstream in `047682a` |

## Implementation from this run

Items 1 to 3, 9 and 10 are implemented locally, starting from upstream commit
`c5cc918`. The source changes accompany this review; deployment is tracked separately.
Prompt builders, role preambles and the design changes in items 4 to 8 remain for our review.

- New successful outcomes save the full final reply and completion cursor. The return
  effect freezes its report reference and public text before sending. Paths include the
  job attempt, and older outcomes and already-prepared returns retain their earlier bytes.
- Each block claims its push and root-message attempts before external delivery. This
  prevents duplicate sends after restart. Push delivery remains best effort: a crash
  between claim and send can lose a notice. The phone's stored Workflow summary remains
  available. A quarantined, unprompted or unavailable root receives no notice; a normal
  root send rechecks the block and compatibility under the shared UI lock.
- A successful configuration apply followed by a present but mismatching session gets
  deterministic Retry. A missing session or another uncertain UI failure keeps the
  existing quarantine behavior.
- The stdio client's HTTP call now lives in `src/mcp/client.ts` and prints structured
  refusals as `code: message`.
- Three consecutive failed wakes exhaust the process-read budget. Audit events retain
  the count across relay restarts. A successful wake resets it. Pre-dispatch and closed
  private-gate failures can defer; a possible UI write retains ambiguous handling.

Verification: focused coordinator and adapter tests cover saved reports, retries, restart,
notification routing, quarantine, known configuration failures and transient process reads.
`yarn verify` passed: type checking, Biome, repository checks, and all 1,142 tests in
151 files. The new orchestration tests use temporary relay databases and fake Conductor
adapters; no live UI run or push was sent. The Node build and its MCP initialization
and EOF-drain smoke check also passed.

## Findings recorded before implementation

These findings preserve the original review evidence. The local fixes above address F4,
F5, F10, F12 and F13; the remaining findings are still open.

**F1. The pipeline shape is fixed before anyone reads the objective.**
The bootstrap explorer's task is the same sentence for every run: "Explore the objective
before implementation". `start()` never passes a task and the start request has no field
for one (`src/orchestration/workflow/start.ts`, `src/orchestration/workflow/http.ts`). The
root prompt says to delegate "tracked code changes" once evidence arrives
(`src/orchestration/workflow/prompts.ts`). `complete()` accepts a run only from
`reviewing` after a delivered implementation Baton (`src/orchestration/workflow/commands.ts`).
A review, audit or research objective can never be marked complete. Its only exit is
Cancel. This run is one of those.

**F2. A child is one shot.**
`readChildOutcome` completes a job on the child's first idle after the task prompt, with no
background task and a last assistant text in that turn (`src/http/services/workflow.ts`). A
question from the child returns as a successful Baton. The root can answer it only by
opening a new child with a new handoff. The first child's context is left behind and its
later turns are untracked. The child prompt tells it to "stop and name the conflict", which
is right, but does not say that stopping ends the job. The design document records
bidirectional relaying as a v1 limit (`docs/designs/delegated-role-chats.md`).

**F3. One delegation per delivered envelope.**
Each accepted `delegate_task` consumes the capability and revokes the rest, then a new
`authorize_phase` effect sends the next envelope as a separate message
(`src/orchestration/workflow/commands.ts`, `src/orchestration/workflow/root.ts`). The root
prompt says "additional tracked explorers" in the plural. A second call in the same turn
answers with a consumed-capability refusal (`assertWorkflowDelegation` in
`src/orchestration/workflow/machine.ts`). The rotated envelope is sent with a plain Return,
so it lands as a steer while the root is mid turn. Nothing tells the planner to wait for it.

**F4. The Baton discards the child's evidence, and the root gets no pointer.**
Every child is told to end with five fixed headings. `readChildOutcome` keeps only the last
assistant text entry of the turn, and `batonText` slices from the `## Baton` heading
(`src/http/services/delegations.ts`). Anything the child wrote before the heading never
reaches the root. `driveJobBaton` sends the Baton tail plus the private blocks and nothing
else (`src/orchestration/workflow/job-results.ts`): no child session id, no cursor.
`list_delegations` drops returned jobs. The ordinary delegation path does the opposite: it
freezes the complete final reply as a report attachment and sends a `read_chat` pointer
(`src/orchestration/delegation/return.ts`). The relay never parses the headings, so the
rigid structure buys the machine nothing.

Live evidence from this run: the explorer wrote a full report with a mapped prompt chain,
six failure modes, edge cases and a test plan. The Baton delivered to the root carried the
five-heading tail alone. `list_delegations` answered "no active or failed delegations". The
root found the chat through the orchestration database, which a planner cannot do.

**F5. The root hears nothing on failure.**
A child failure calls `blockRun`, which writes the database and nothing else
(`src/orchestration/workflow/state.ts`, `src/orchestration/workflow/job-results.ts`). No file
under `src/notifications/` references Workflows. A planner told it "does not need to poll"
waits forever. Live evidence: this run blocked at 16:24:28. The root chat received nothing
and no push went out. The phone's summary was the only signal.

**F6. The root prompt stops at implementation.**
The prompt says nothing about what the planner may do after the implementation Baton. The
state machine allows another implementer, or an explorer that opens a new cycle
(`workflowDelegationTransition`), and only the phone can press Complete. Only the private
envelope's allowed roles hint at this, and the prompt forbids reading that block in prose.
No coordinator test drives a second cycle; only a pure unit test covers the transition.

**F7. The brief cannot be iterated.**
A Workflow starts only from a chat with no user rows, no user timestamp and no queued
prompt (`workflowRootInspection` in `src/http/services/workflow-probes.ts`). The objective
must be written in one message. It is then re-quoted as immutable into every child prompt.

**F8. The handoff has no cap.**
`materializeHandoff` renders the root transcript with reasoning on and tools off, with no
byte limit, and every child is told to read it first (`src/http/services/workflow.ts`). The
bootstrap explorer's cursor is frozen at the root prompt row, so it received 2 kB. A
delegation from the same root later in the run would have attached about 69 kB of prose
and reasoning, of which 57 kB was reasoning.

**F9. The read-only rule forbids a scratch reproduction.** (from the explorer)
An explorer that may not edit files cannot write a reproduction script or a spike, which
is often the strongest evidence it could give.

**F10. A verification mismatch after a successful apply is classed ambiguous.**
`configureSession` applies the role, gets an ok from `applyAgentPatch`, then re-checks with
`sessionMatchesWorkflowRole`. A mismatch there throws after the effect's may-execute point,
so `runDurableEffect` marks the effect ambiguous, activates the global UI quarantine and
blocks the run with only a risky replay offered (`src/orchestration/workflow/effects.ts`).
At that point nothing is in flight: the UI write finished and the database was read. Live
evidence: the first-ever run blocked this way because two matchers disagreed about an
OpenCode label. Upstream `047682a` made the probe reuse the agent-config matcher, and the
relay's auto-update to 1.122.1 reconciled the effect on restart. The classification is
unchanged.

**F11. Smaller prompt issues.**
- The exploration preamble in `roles.json` asks for "a focused implementation/test plan",
  which presupposes a change.
- "Files changed" and "Suggested next role" are noise for a read-only explorer.
- The planning preamble asks the root to end a message to a human with a suggested next role.
- The `handoffAttachment` parameter of `workflowChildPrompt` is dead in production. Job
  dispatch appends the real attachment after the Baton format, so tests exercise a shape
  that is never sent.
- The `delegate_task` description mixes ordinary and Workflow rules in one long paragraph.
- A scope-conflict stop has no resume instruction. (from the explorer)

**F12. The MCP client hides relay refusals.**
`call` in `src/mcp.ts` throws `` `${payload.error || ...}` ``. The Workflow routes answer with
an error object `{ code, message, retryable }` (`workflowHttpError` in
`src/http/services/workflow-state.ts`), so the planner sees `[object Object]` instead of
the reason. Live evidence: the root's implementation delegation was refused with
`workflow_blocked`, and the tool answered `[object Object]`. The root learned the reason
from the orchestration database.

**F13. A transient read failure in the compatibility gate blocks the run until a human acts.**
`wakeInternal` calls `assertCompatible` on every step and blocks the run with
`workflow_incompatible_relay` on any throw (`src/orchestration/workflow/wake.ts`). The probe
wraps a `ps` call with a 6 s timeout (`src/host/relay-processes.ts`), and a failed `ps` is
reported as "could not verify" (`workflowCompatibilityError` in `src/http/services/base.ts`).
`reconcileBlockedEffect` only reconciles ambiguous effects, so a compatibility block waits
for the phone's Retry even though the check is read-only and `retry()` itself notes that
"unblocking is the retry". Live evidence: at 17:08:55 the `ps` command failed under load
and this run blocked in planning with no incompatible relay alive. The `ps` output measured
193 kB against a 4 MB buffer, so the timeout is the likely cause.

**Claims from the explorer that the code does not support.**
- "Strict Baton headings risk silent truncation; the parser expects exact headings." The
  parser looks only for the `## Baton` heading and otherwise passes the whole last message.
  Renamed headings cannot block the barrier. The real cut is the opposite one (F4).
- "A thin Baton means the barrier never satisfies." A thin Baton satisfies the barrier.
  Only a failure blocks the run.

**What holds up.**
The objective is preserved verbatim and kept apart from the planner's interpretation.
Children get a guard against silent scope change. The root may question the user. The
ordinary path's report design is the right model to copy.

## Recommendations

### 1. Deliver the complete child reply with every Baton

Kind: relay. Status: implemented locally.

What: mirror the ordinary delegation return. Freeze the child's complete final reply in the
job outcome at completion. At return, write it as a report attachment in the worktree and
send the root the Baton tail, the report token, and a `read_chat` pointer with the child
session id and completion cursor. Keep the Baton tail inline so the root prompt's promise
("it will deliver a Baton here") stays true.

Why: F4. The planner needs the evidence, not only the verdict, and needs to know where the
child chat is.

Where: `WorkflowChildOutcome` in `src/orchestration/workflow/types.ts`, `readChildOutcome`
in `src/http/services/workflow.ts`, `driveJobBaton` in
`src/orchestration/workflow/job-results.ts`, a report builder beside
`src/orchestration/delegation/return.ts`, `stableWorkflowAttachment` in
`src/http/services/workflow-probes.ts` for a retry-stable path.

Acceptance:
- The message the root receives contains the Baton tail, `Report: <token>`, and
  `read_chat({"session_id": ..., "near": ..., "before": 6, "after": 0})`.
- The report body is the saved final reply, never a rescan of the child transcript.
- The public return text and report are identical across retries of the return effect.
  Private phase capabilities keep their existing rotation and receipt contract.
- The ordinary delegation report path stays byte-identical.
- Secrets are scrubbed with `scrubWorkflowSecrets` before anything is written or sent.

### 2. Tell the root and the phone when a run blocks

Kind: relay. Status: implemented locally.

What: when a run enters `blocked`, send one push to subscribed devices and post one short
message into the root chat. Both name the workspace, the phase, the failed action in plain
words, and the phone action available (Retry, risky replay, or Cancel). The root message
also says that further Baton sends are paused until recovery. A Baton already accepted
into Conductor's outbox can still arrive.

Why: F5. An unattended planner and an unattended phone both need the signal.

Where: `blockRun` in `src/orchestration/workflow/state.ts`, the wake loop's blocked branch
in `src/orchestration/workflow/wake.ts`, the push path the parked-prompt queue already uses
for landed-or-failed (`src/delivery/parked.ts` and its notify dependency), `chatRoute` in
`src/notifications/notify.ts`.

Acceptance:
- One persisted push attempt and at most one root-message attempt per block event, across
  relay restarts. External delivery is best effort; claims prevent repeat attempts.
- The root message is a UI write. Send it only while no UI quarantine is active, at
  background priority, queued behind the root's current turn. Its failure never changes the
  run's state and never blocks the run again. One attempt, then rely on the push.
- Skip the root message when the root chat itself is the failure (root not pristine,
  workspace gone).

### 3. Classify a post-apply verification mismatch as deterministic

Kind: relay. Status: implemented locally.

What: when `applyAgentPatch` returned ok and the frozen-role probe still disagrees, mark the
effect failed with retry class deterministic, do not activate the UI quarantine, and let the
phone offer Retry.

Why: F10. Nothing is in flight at that point. The ambiguous class exists for a UI action that
may or may not have happened, and pauses every remote control.

Where: `configureSession` in `src/http/services/workflow.ts`, the post-dispatch catch in
`src/orchestration/workflow/effects.ts`.

Acceptance:
- A mismatch after a successful apply blocks with `retryClass: deterministic`, `canRetry`
  true, and no quarantine row activated.
- Every other post-dispatch failure keeps today's ambiguous handling.
- If the catch cannot tell the two apart safely, skip this item and say why.

### 4. Tell the root the mechanics it depends on

Kind: prompt. Status: waits for the owner's read.

Add to the root prompt, in plain words:
- Each accepted `delegate_task` consumes the capability. The next envelope arrives as a
  later message. Wait for it before the next delegation.
- A child ends on its first answer. A question from a child ends its job. Answer it by
  opening a new job that quotes the question and the answer.
- What each phase allows. After the implementation Baton the run is in reviewing. The
  planner may request one more implementer, or an explorer that opens a new cycle. Only
  the phone presses Complete, so end the turn with a clear "ready to mark complete" or
  "needs another pass".
- Where a child's chat is (the report pointer from item 1, or `list_chats`).
- Remove the presupposition of a change. Say "if the objective needs code changes, delegate
  them to the implementation role" instead of "delegate tracked code changes".

### 5. Loosen the child prompts and preambles

Kind: prompt. Status: waits for the owner's read.

- Make the Baton headings a suggestion. Keep Decision, Evidence and Risks. Drop "Files
  changed" and "Suggested next role" for explorers.
- Tell the child that stopping ends the job, and to put its question in the Decision.
- Allow an explorer to run tests and to write scratch files under `.context/scratch/` for
  a reproduction. Keep source files read-only.
- Exploration preamble in `roles.json`: replace "a focused implementation/test plan" with
  "evidence the planner can act on".
- Planning preamble: drop the Baton requirement for messages addressed to the user, or make
  it optional.
- Bootstrap task text: make it objective-neutral, for example "Map the code and constraints
  the objective touches and return evidence the planner can use".
- Remove the dead `handoffAttachment` parameter or make dispatch use it, so tests match
  production.
- Split the `delegate_task` description into an ordinary paragraph and a Workflow paragraph.

### 6. Let the objective decide the shape

Kind: design. Status: later.

- Allow Complete from planning when the planner declares that no implementation is needed.
  A review or research objective then has a proper end.
- Let the phone set the bootstrap explorer's task, or skip the bootstrap explorer and let
  the planner write its own first question.

### 7. Follow-up delegation into an existing child chat

Kind: design. Status: later.

Add a tracked follow-up that sends a second prompt into an existing child chat and tracks
the new turn to completion. `readChildOutcome` already keys on the task receipt's turn id,
so the completion reader needs little change. This is what makes root-to-child iteration
real and keeps the child's context alive.

### 8. Cap or scope the handoff

Kind: design. Status: later.

Cap the rendered handoff in bytes, or default to the planner's own brief and make the full
transcript opt-in per delegation. The planner's task text is already the focused
assignment.

### 9. Render relay error objects in the MCP client

Kind: relay package, MCP client side. Status: implemented locally.

What: when a relay answer carries an error object, format it as `code: message` before
throwing. Keep string errors as they are.

Why: F12. A planner that cannot read a refusal cannot act on it.

Where: `call` in `src/mcp/client.ts`, imported by the stdio entrypoint `src/mcp.ts`.

Acceptance: a unit test feeds a `{ error: { code, message } }` refusal through the client
path and asserts the thrown message contains both fields and never `[object Object]`.

### 10. Do not block a run on a transient compatibility read

Kind: relay. Status: implemented locally.

What: separate "could not verify the relay processes" from "verified an incompatible relay".
A verification failure is retried on later wake ticks with a bounded budget and blocks the
run only after repeated failures. A verified incompatibility keeps today's immediate block.

Why: F13. The check is read-only. A failed `ps` under load is not an incompatible relay.

Where: `workflowCompatibilityError` in `src/http/services/base.ts`, `assertCompatible` and
`wakeInternal` in `src/orchestration/workflow/state.ts` and `src/orchestration/workflow/wake.ts`.

Acceptance:
- A single thrown `ps` failure leaves the run in its phase and the next wake retries.
- Repeated failures past the budget block the run with `workflow_incompatible_relay`,
  retry class deterministic, and the message names the read failure.
- A verified incompatible PID blocks on the first check as today.
- The budget is persisted or derived from events so a relay restart cannot reset it forever.

### Shipped upstream already

- `047682a`: `sessionMatchesWorkflowRole` reuses `agentConfigMatches`, with a role-match
  test file that covers the OpenCode label.
- The blocked phase label is now "Coordination paused" and the quarantine banner reads
  "Remote controls are paused".

## Out of scope

Same-provider subagents, Conductor Plan mode, and the ordinary delegation queue's own
design. The ordinary path is the reference the Workflow path should converge on.
