# Design seed: Fresh-context task rollover

Status: IDEA — intentionally separate from delegated role chats

## Problem

Long implementation tasks can force a GPT chat through repeated context compaction.
The worktree survives, but increasingly compressed conversation history makes the
agent lose decisions, constraints, and the thread of the implementation.

## Product shape

Continue the same task in a fresh sibling Conductor chat on the same provider and
model. There is no planning stage and no return to a parent orchestrator: ownership
moves forward to the new chat.

The old chat prepares a compact Baton with the objective, decisions, constraints,
files changed, verification state, unresolved failures, and exact next action. The
relay opens the sibling chat in the same worktree, attaches the useful transcript
cut plus Baton, copies the current model/effort/fast settings, and sends a continuation
prompt. Conductor Plan mode is not involved.

The first version should be manually triggered. Automatic rollover needs evidence
for a trustworthy context-pressure signal; a raw token count or one compaction event
may not mean the current chat has actually become harmful.

## Why this is not `delegate_task`

`delegate_task` intentionally crosses providers, keeps a parent/child relationship,
and returns a result. Rollover is same-provider, linear, and transfers ownership. A
separate operation keeps both contracts honest and avoids weakening delegation's
same-provider refusal.

## Likely reuse

- The existing transcript attachment and sibling-chat opening path.
- The two-stage agent configuration receipt, using the old chat's effective settings
  instead of a named role.
- Persisted, lock-aware queue mechanics so a handoff survives relay restarts.
- Session-role/pipeline presentation, extended with a lineage marker such as
  `continued from` / `continued in` rather than a delegated role.

## Questions for a full design

- Manual command name and phone placement (`continue_task`, `roll_over`, or a chat
  action beside Fork).
- Whether the Baton is written by the current agent, synthesized deterministically
  from state, or both.
- Which context-pressure measurements Conductor exposes, including whether compaction
  events can be distinguished from ordinary token growth.
- Whether the prior chat becomes read-only in the phone UI or merely links forward.
- How much transcript to attach once the Baton is sufficient; copying the entire
  compacted history would recreate the problem.

## Success criterion

A user can move a large in-progress GPT task to a fresh GPT chat in the same worktree
with its decisions and verification state intact, continue immediately, and avoid a
planning/orchestrator round trip or Conductor Plan mode.
