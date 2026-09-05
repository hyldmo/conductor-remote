# Conductor agent routing for gstack and other skills

User instructions can route a skill's helper work through `conductor-remote` while
preserving its tasks, review criteria, and output format. This is a prompting override;
it does not replace gstack code or modify its generated skill files. The relay still
enforces role validation and Workflow ownership when a task reaches it.

Place the block below in the user instructions loaded by your agent: for example,
`~/.claude/CLAUDE.md` for Claude Code or `~/.codex/AGENTS.md` for Codex. Keep it in
project instructions too if other team members should use the same routing. A running
chat may need to reload its instructions and MCP tool definitions after an update.

```markdown
## Conductor agent routing (including gstack)

Within a local Conductor workspace, route helper agents requested by the user or an
explicitly invoked skill through conductor-remote MCP. This overrides skill-specific
Agent/Task/subagent calls and helper provider CLI spawning, including in gstack.
Within Conductor, it also overrides generic helper-provider preferences and any
provider or model named by a skill: use the configured role settings instead.
Preserve the skill's task scope, review criteria, and output format. An explicit
user request for a native tool, provider, or particular model takes precedence.

For an ordinary chat, call list_roles, then delegate_task with the parent session_id,
role, and a focused prompt. Choose a valid configured role whose instructions fit
the task; prefer exploration for codebase searches, investigation, and verification
when its configuration fits. The relay applies that role's model, effort, Fast mode,
and preamble. Do not infer or override those settings from a role name or skill.
Include any required review perspective and output format in the assignment.
If the user explicitly requires a provider or model, choose a matching valid role;
if none exists, report the mismatch instead of substituting one. For implementation,
specify file ownership and tell the child it shares the worktree and must respect
others' edits.

Separate independent questions into separate calls within the user's authorized agent
count and spending limits. Continue useful local work while children run, then integrate
their results; list_delegations and read_chat can inspect progress. For ordinary tasks
whose result is needed during this turn, use return_mode="steer"; the default "queue"
returns behind the current turn. Keep each child scoped to its task. Suggested next
roles do not automatically start another phase.
Do not turn a helper request into a planning/exploration/implementation Workflow.

Inside an active Workflow, its frozen roles and current phase rules apply. Only its
root may delegate, with workflow_id and phase_capability from its private envelope.
Never invent credentials or bypass the managed path through ordinary delegation,
split_chat, native subagents, or CLI helpers. Do not enable Conductor Plan mode.

If the relay is unavailable, the requested role is invalid, or delegate_task still
requires Workflow credentials for ordinary chats, report that limitation and continue
locally where possible. Do not start a Workflow as a fallback. Existing user limits
on extra reviewers, spending, and external actions still apply.
```

For lightweight delegation the current tool schema requires only `session_id`, `role`,
and `prompt`. A schema requiring `workflow_id` and `phase_capability` for every call
comes from a Workflow-only relay release. Update the relay and reconnect the MCP client
before expecting the ordinary-chat route to work. No gstack source update is required.
