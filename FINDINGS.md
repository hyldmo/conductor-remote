# Reconnaissance findings

Everything here was verified against the installed build, not assumed.
**Conductor 0.76.0**, `com.conductor.app`, Tauri v2 app, macOS (Darwin 25.5).

## TL;DR — the plan changed under the evidence

The committed design was "confine coupling to writes, do writes via an injected
script that calls Tauri `invoke(...)`." Recon showed two things that reshape it:

1. **Reads need zero Conductor coupling and zero injection.** All state —
   workspaces, live session status, and the *complete* transcript of every
   agent — lives in a local SQLite DB. Diffs come from the git worktrees. We
   read both directly.
2. **The webview-injection write path is effectively closed on this build.**
   The app is hardened/notarized, its frontend is compiled into the binary
   (nothing to patch), devtools are off (nothing to paste the recon snippet
   into), and the only IPC commands that exist are stock Tauri plugins — there
   is no custom `send_message` to call even if you got inside.

So the architecture is now: **reads over SQLite + git (durable, uncoupled);
writes over macOS Accessibility (the one fragile nerve).** That is still the
"one coupled surface" the plan wanted — just realized through AX, not IPC.

---

## Reads — solved, and better than the "tail files" idea

### State DB (the goldmine)
`~/Library/Application Support/com.conductor.app/conductor.db` — SQLite in WAL
mode. A second **read-only** connection sees every committed write live without
touching the app. Relevant tables:

- `workspaces` — `id, directory_name, workspace_name, branch, state, derived_status, active_session_id, unread, intended_target_branch, …`. `state` is `ready` (live) or `archived`; the sidebar status is `manual_status` (user override) falling back to `derived_status` — values `backlog` / `in-progress` / `in-review` / `done` (the desktop sidebar's groups). **`unread` is dead** — declared, migrated, and 0 on all 1691 rows; unread lives on `sessions` now (below).
- `sessions` — `id, status ('working'|'idle'), workspace_id, title, model, permission_mode, context_used_percent, unread_count, updated_at`. **Live agent status, for free.** `unread_count` is a 0/1 **flag**, set when an agent finishes a turn the app isn't showing (watched live: a session flipped `working:0` → `idle:1` the moment it finished unfocused) and cleared by opening that workspace on the Mac. `updated_at` tracks the last message to the second, so it doubles as "has anything happened since" — but it's SQLite's `YYYY-MM-DD HH:MM:SS` (UTC, no `T`/`Z`), so compare it with itself, never with `Date.parse`.
- `session_messages` — `session_id, role, content, full_message, created_at, sent_at, queue_order, turn_id`. Assistant/system rows store raw Claude Code SDK stream JSON; user prompts store plain text. `queue_order` set + `sent_at` null ⇒ a queued-but-unsent message. **This is the full transcript.**
- `repos` — `id, name, root_path, default_branch`. `root_path` is the primary checkout; worktrees live at `<workspacesRoot>/<repo.name>/<directory_name>`.
- `diff_comments`, `terminal_sessions`, `attachments`, `settings` — secondary.

Model state splits across those sources. A chat's live choice is durable in
`sessions.model`; effort is provider-specific (`claude_effort_level` for Claude,
`codex_thinking_level` for Codex). The similarly named defaults still present in
the DB's `settings` table are legacy rows, not the current preference source:
on 2026-09-02 the DB still said Codex `high` while the TOML and newly created
Codex chats used `xhigh`; starring `5.6 Terra` changed neither
`settings.default_model` nor either default-effort row (all retained their June timestamps). It rewrote
`~/.conductor/settings.toml` under `[models]` and changed the target chat's
`sessions.model`, because the star's actual AX label is **“Set … as default and
select.”** Starring `5.6 Sol` restored both live values; the DB settings rows
again did not move. Default reads therefore come from the starred picker / user
settings TOML, never those stale DB rows, while per-chat reads remain SQLite.

The phone's **Models** sheet reads and updates the two file-backed new-chat
defaults directly: `models.claude_code.default_effort_level` and
`models.codex.default_thinking_level`. `src/conductor-settings.ts` changes only
the requested assignment and writes atomically, preserving comments, review
levels and unknown future keys around it. Cursor Agent and OpenCode have provider
cards in the same sheet but no invented effort setting: Conductor's user schema
defines provider-specific defaults only for Claude Code and Codex.

Crucially, **Conductor's `sessions.id` equals the Claude Code `claude_session_id`** — the app is a GUI over Claude Code sessions.

### Diffs
Every workspace is a real git worktree (`git worktree list` confirms). Diff vs
the target branch is `git -C <worktree> diff $(git merge-base <base> HEAD)` —
committed + uncommitted, exactly Conductor's diff view, computed with no
Conductor involvement at all. The phone sidebar's `+adds -deletes` uses the same
tracked-plus-untracked basis without constructing the full patch. `/api/state`
serves a cached answer immediately and a four-worker background queue refreshes
working or newly-updated rows every few seconds; idle rows get a one-minute
safety refresh, so a long workspace list does not fork git processes every 2.5s.

### Plan usage — prompt-free through the provider CLIs
The sidebar's `resource-usage` value is not stored in Conductor's SQLite DB. The
two major harnesses do expose it through the exact binaries Conductor bundles:

- **Codex 0.147:** newline-delimited app-server protocol. After `initialize` +
  `initialized`, `account/rateLimits/read` returns `planType`, named limit buckets,
  `usedPercent`, `windowDurationMins`, `resetsAt`, and credit state. This is a
  purpose-built structured read and sends no turn.
- **Claude Code 2.1.257:** print mode accepts the experimental stream-JSON control
  request `{subtype:"get_usage"}` and returns the same data the interactive `/usage`
  dialog renders: subscription type, session/weekly/model-scoped percentages and ISO
  reset times. `--safe-mode --no-session-persistence` avoids user hooks/plugins and a
  throwaway persisted session. This is better than either parsing the TUI or calling
  its private `/api/oauth/usage` endpoint with credentials ourselves, but its own
  schema says experimental, so the parser also understands the older named-window
  response.

Cursor Agent has only auth status in its CLI, and OpenCode `stats` totals locally
recorded tokens/cost rather than a provider subscription allowance. The relay reports
those two as unavailable. `src/plan-usage.ts` normalizes the supported responses,
runs them concurrently on demand, coalesces simultaneous reads, and caches the result
for one minute; no plan read rides the 2.5s workspace poll.

**Durability:** an app update can rename every UI string and both read paths
keep working. The schema has migrated additively (`_sqlx_migrations`, many
`ALTER TABLE ADD COLUMN`), so column adds won't break us; only a destructive
rename of `session_messages`/`sessions` would, and that's rare and cheap to remap.

---

## Writes — the real problem, honestly

### ✗ Webview injection + Tauri `invoke` (the committed plan) — blocked
- **Frontend is baked into the binary.** `Contents/Resources/` holds only `icon.icns`, a `bin/` (helpers), and the skill bundle — **no `index.html`, no `assets/`.** The Tauri runtime + all web assets are compiled into `Contents/MacOS/conductor`. There is nothing on disk to patch a `<script>` into, so the "patch index.html + launchd re-patch" persistence mechanism has no target.
- **No devtools.** Entitlements are only `allow-jit`, `allow-unsigned-executable-memory`, `device.audio-input` — **no `com.apple.security.get-task-allow`.** On macOS 13.3+ a `WKWebView` is inspectable only if the app opts in; a hardened, notarized production build without `get-task-allow` won't appear in Safari's Develop menu. **There is no console to run the recon snippet in.**
- **No custom IPC commands *in the Tauri webview boundary*.** The Tauri
  `invoke` ACL exposes only stock plugins (`plugin:sql|*`, `plugin:shell|*`,
  `plugin:fs|*`, `plugin:window|*`, …) — so there's no `send_message` reachable
  from inside the webview even if you got there. **But that's not where the send
  actually happens** (see the sidecar socket below): the frontend talks to a
  separate `conductor-runtime sidecar` process over a unix socket, and *that*
  protocol has the real `sendUserMessage`/`query` verbs. The earlier "no custom
  IPC anywhere" reading was wrong — it was true only of the `invoke` surface.

Getting inside would mean re-signing the app with `get-task-allow` (breaks
notarization, needs Gatekeeper disabled) or attaching a debugger under disabled
SIP — heavier and more fragile than the plan assumed. The recon snippet is kept
in `scripts/devtools-recon.js` for a hypothetical future build that ships
devtools, but it can't run today.

### ✗ Supported public API / CLI / MCP — cloud only
`Contents/Resources/bin/conductor` is a real CLI ("Command-line interface for
the Conductor public API") with `messages create` (queue a user message),
`sessions`, `workspaces`, read-only `sql`, `openapi`, and even `--mcp` stdio
mode. But it targets **`https://api.conductor.build`** and requires a token from
`app.conductor.build/users/api-keys`; `workspaces` are "cloud workspaces." With
no cloud access it can't see or drive local sessions — confirmed: `sql` errors
`No API token found`. Dead for local control, matching the earlier conclusion.

### ✗ Raw DB insert alone — probably a ghost
User prompts *are* rows in `session_messages` (`role='user'`, `queue_order`,
`sent_at`, `sender_id`). But the dispatch is done by Conductor's Rust backend
feeding the `claude` subprocess — the row is a *record* of that, almost
certainly not a *trigger*. Inserting one likely shows a message in the UI that
never runs. Left as an opt-in, clearly-labeled experiment
(`UNSAFE_DB_WRITE=1` → `DbQueueActuator`, currently a stub) to be validated
only by live observation, since it risks racing the app's writer.

### ✗ Raw DB write for workspace status — measured, and it is a ghost
The same question for `workspaces.manual_status`, which is pure sidebar state
rather than a dispatch trigger, so the "record, not trigger" argument above does
not apply to it. Everything about the *write* is easy: the file is `-rw-r--r--`
and ours, the column is plain `TEXT` with no trigger and no constraint,
**Conductor does not even bump `updated_at`** on a status change (a row flipped
twice through the app's own menu still read `2026-05-09`), and there is no cloud
sync to desync — `organization_id` and `creator_user_id` are null on all 2115
workspaces here, and the outboxes are for messages and assets. The `UPDATE`
lands in **0ms** and is never clobbered.

Conductor just never reads it. Measured 2026-09-01 on one live workspace, DB set
to `backlog` while the app believed `canceled`: unchanged after 90s; unchanged
after expanding the sidebar section holding it; and unchanged after **opening the
workspace outright** via its own `conductor://workspace?id=…` link — the pane
loaded that workspace and computed its diff (`97 files changed +14552 -0`) while
the sidebar still grouped the row under Canceled. Fifteen minutes and a full
navigation later the DB still said `backlog` and the UI still said `canceled`.
(One nudge came back inconclusive rather than negative: pressing **Toggle left
sidebar** does not unmount the list — 49 rows stayed visible to Accessibility
right through the "collapsed" state — so it never tested a remount. A process
restart is the one lever likely to re-read SQLite and was not tried, since two
agents were working; it is useless as a mechanism anyway.)

So the trap is not that the write fails. It is that **the write succeeds for
every reader except the one that matters**: `reads.ts` selects `manual_status`
straight from the row, so the phone would show the new status, confidently and
wrongly, while the Mac showed the old one. Worse, `server.ts`'s status route
confirms success by re-reading that same column — a DB-writing actuator would
confirm against its own write and always return `ok`, turning the one check that
catches a failed press into a check that can never fail. Hence the AX path
(`setWorkspaceStatus` in `writes.ts`), at 5-8s, stays.

### △ Frontend workspace service — the missing half of the raw DB write
Conductor 0.83.1's production frontend answers the ghost-write mystery exactly.
The real status method does two things inside one serialized workspace action:

```ts
await db.execute("UPDATE workspaces SET manual_status = ? WHERE id = ?", [status, workspaceId])
updateCachedWorkspaceForAction(workspaceId, workspace => ({ ...workspace, manualStatus: status }))
```

The UI mutation then refreshes that workspace and records the
`workspace_status_changed` metric. A raw SQLite update performs only the first
line, so the sidebar is not stale accidentally; the live workspace store is the
authoritative frontend copy until something explicitly refreshes it.

There is a clever diagnostic escape hatch. **Help → Open Debug Tools** works in
this production build, and its main asset exports the live workspace-service
singleton. In 0.83.1 that is the version-hashed
`/assets/index-DdVcOIDT.js` export `U`; a read-only probe confirmed that it has
both `setWorkspaceManualStatus` and `refreshWorkspace`, and that it returns the
cached status for a workspace by id. Calling those methods would perform the
same DB + store mutation as the UI without finding a sidebar row.

That is not the relay's default actuator. Both the asset hash and the minified
export name can change on every Conductor release, Web Inspector visibly resizes
the app and must take keyboard focus, and there is no supported external
JavaScript-evaluation channel. Automating the inspector would therefore replace
a semantic AX menu operation with coordinates plus private bundle internals. It
is useful for diagnosis and as a manually enabled experiment; the AX path remains
the safer shipping mechanism.

### ✓ Native Continue action — same workspace, fresh branch
The merged-workspace **Continue** button is not shorthand for creating another
workspace. Decompiling the production `renderApp` chunk and checking a workspace
that had already used it showed the same workspace id, worktree and session ids on
both sides of the transition. The native operation fetches the PR target, checks
out a unique branch from it in the existing worktree, then records the new branch
and clears the old PR title/description. Its durable write is:

```sql
UPDATE workspaces
SET branch = ?, placeholder_branch_name = ?, pr_title = NULL, pr_description = NULL
WHERE id = ?
```

The component also stages `Branch continued.md` in the active chat with a note
naming the new branch and its remote/base. That makes a relay-side `git checkout`
incomplete, and a matching raw SQLite update would violate the read-only DB rule
while still missing Conductor's live store. The safe actuator is therefore the
actual AX button, whose visible name is `Continue` and whose tooltip is “Continue
on a new branch with the same chats.” The relay focuses the phone's selected chat,
presses one unambiguous shallow match, and uses the read-only branch change as the
receipt. Conductor exposes the control for merged, non-archived workspaces; the PWA
and HTTP route enforce the same boundary.

### △ Built-in app-actions bridge — one DB flag unlocks it, but the connection won't hold
The same production UI bundle carries a Playwright-style DOM action loop, and it
is the most principled route found. Once running, the frontend polls
`poll_app_action`, runs `execute`/`query`/`explore` requests against its own DOM,
and returns each result through `submit_app_action_result`. `conductor-runtime
actions` is the matching localhost HTTP server (`GET /health`, `GET /describe`,
`POST /execute|/query|/explore`) and writes its port to
`…/com.conductor.app/logs/latest-actions-server.json`. Locators are `role`,
`text`, `testId`, `label`, `placeholder`, `css`.

**The gate is a single local DB flag, not an employee account.** Decompiling the
`renderApp` chunk (brotli-embedded in the Tauri binary) shows the poll loop
starts on exactly:

```js
s = !initialLoadInProgress && (isDevMode || settingsByKey.internal_settings_enabled === "true")
```

The same flag flips the whole internal-user state (it drives
`configure_sidecar_internal_user`), with no roundhouse or account check anywhere.
Measured 2026-09-01: writing `internal_settings_enabled='true'` into the
`settings` table and restarting Conductor started the actions server, and the
webview connected to it — `/health` read `connected:true`. So the flag alone
opens both gates: the Rust side (`app_actions.rs` runs
`SELECT value FROM settings WHERE key='internal_settings_enabled'`) and the
frontend loop. The earlier "doubly gated" reading was too pessimistic. You do not
launch the server yourself; the app launches it once the flag is set.

**But the connection does not hold, and that half is Conductor's, not ours.**
Across app restarts the webview stopped polling and did not reliably re-attach:
`/health` sat at `connected:false` for minutes while the server was up and idle,
so no queued `/execute` was ever picked up (`pendingActions:1`, unclaimed). The
poll loop is perpetual once started (`jFi` loops until aborted, catches errors
with a 2s backoff), so the fault is in its lifecycle after a reload, which the
relay cannot reach or repair from outside.

Two more caveats even if it did hold. The `/execute` action set is `click,
dblclick, fill, clear, check, uncheck, selectOption, hover, focus, blur, press` —
there is no right-click, and workspace status is a right-click context menu on
the sidebar row, so that one operation may not be reachable through this API even
when connected. And the server binds `127.0.0.1` with no auth on `/execute`, so
enabling it opens an unauthenticated local control surface for the whole UI.

Verdict: a real future path if Conductor ever keeps the automation client
reliably connected, or ships a supported switch, and the first one to revisit
then. Today it is not a reliable actuator, so the AX path
(`setWorkspaceStatus`) stays. The `internal_settings_enabled` row written during
this test was reverted afterwards.

### ✓ Sidecar IPC socket — the precise path (opt-in `WRITE_STRATEGY=sidecar`)
Conductor's agents don't run under the Tauri app directly. A single
**`conductor-runtime sidecar`** process (child of the app) **parents every live
`claude`/`codex` agent**, and the app drives it over a unix domain socket:

```
$TMPDIR/conductor-sidecar-v2-<sidecarPid>.sock
```

The wire protocol (reverse-engineered from `conductor-runtime`, Conductor 0.76):

- **Transport:** newline-delimited **JSON-RPC 2.0** (`{jsonrpc,id,method,params}`)
  over a raw `net` socket. (Stale socket files from exited sidecars linger in
  `$TMPDIR`, so discovery is connectivity-based: try candidates newest-first, use
  the first that accepts a connection.)
- **Local auth:** the literal `{ userId: "local", auth: "local" }` — local
  (non-cloud) sessions authenticate with the constant string `"local"`. Verified:
  the socket accepts it and round-trips zod-validated responses.
- **Send a prompt:** method `query`, params
  `{ type:"query", id:<sessionId>, agentType:"claude", message, prompt, options:{ cwd, … } }`.
  For a session already loaded in the sidecar's store (i.e. a live agent), the
  message is simply enqueued to that session — addressed by `sessionId`, so no
  window focus is involved and the app UI updates correctly.
- **Safe reads** (no turn triggered): `contextUsage`, `fetchSlashCommands`,
  `getSessionStatus`.

This is the app's **real** dispatch path and gives exact per-session targeting.
It's opt-in rather than default because (a) it speaks a private, versioned
(`-v2-`) IPC — the most update-fragile surface here — and (b) `options` carries
agent-spawn params (`cwd`, `model`, `permissionMode`, `resume`, …); a live send
was not auto-validated to avoid injecting a prompt into a running agent. The
socket + auth + protocol *were* validated with the safe read RPCs. Implemented in
`src/sidecar.ts`; wired as `SidecarActuator` in `src/writes.ts`.

Also on this socket: the `app_actions` HTTP server above is unlocked by the
`internal_settings_enabled` DB flag but will not hold a webview connection (see
that section), while the `conductor cli` remains cloud-only
(`api.conductor.build`) — neither is a reliable local-control path today.

### ✓ macOS Accessibility (AppleScript) — the safe default
`AppleScriptActuator` activates Conductor and pastes+sends the prompt via
System Events. It drives the app's **real** send path — no injection, no DB
poking, works on the hardened build (Accessibility is an OS permission the user
grants once). Coupling is to the prompt field, not the frontend bundle, so it
survives UI-bundle updates.
- **Targeting is id-addressed, not label-addressed.** Conductor 0.71 added a
  link to a workspace *and one chat inside it* — the sidebar row menu's "Copy
  link" (Cmd+⇧C) — and 0.80.1 answers it locally:
  `conductor://workspace?id=<workspace>&session=<chat>`, both ids the ones the
  relay already reads. The `conductor://` scheme was registered all along
  (`CFBundleURLSchemes = [conductor]`, `tauri-plugin-deep-link`); what was
  missing was a route that focuses rather than creates.
  - The near misses fail *badly*, so build the URL in one place
    (`writes.ts` ▸ `workspaceLink`): `workspace` must be the **host** and the
    parameters sit behind a real `?` (unlike the flat create-workspace links).
    `conductor:///workspace/<id>` — id in the path, empty host — falls through
    to the flat-parameter parser and **creates a new workspace in the first
    repo**. `conductor://workspace/<id>` is merely ignored.
  - The shareable form Conductor copies is
    `https://app.conductor.build/workspace/<id>?session=<chat>`, and the app
    parses it too, but the desktop build declares no associated domain, so
    macOS hands it to a browser first. Locally the scheme form is the one that
    always lands.
  - The scheme is per release channel (`conductor-alpha://`, `conductor-beta://`
    …). Only production is addressable anyway — every AppleScript here says
    `application "Conductor"` — so it is a constant with an env override.
- **Stopping a turn is a keystroke, because the button is anonymous.** Conductor
  binds **`⌘⇧⌫` to "Cancel agent"** — from its own Keyboard shortcuts dialog
  (`⌘/`, section "Chat"), which is also where `⌘L` (focus chat input), `↵` /
  `⌫` (approve / deny a tool request) and `⌘⇧↵` (approve plan) are listed. That
  dialog is the place to re-derive any of these; the menu bar carries none of
  them. The composer's stop button was rejected as the lever after reading its
  whole AX record: `AXTitle`, `AXDescription`, `AXHelp`, `AXIdentifier` and
  `AXCustomContent` are all empty, leaving only `AXDOMClassList`. Worse, the
  slot is not stable — measured on Conductor 0.80.1, right end of the composer:
  idle + empty box = one button (send, `ml-1 bg-foreground/50
  cursor-not-allowed`); idle + text = one button (send, `ml-1 bg-foreground`);
  **working + empty box = one button (stop, `border-border`, no `ml-1`);
  working + text = two buttons, stop at the left and send at the right**. So
  "press the rightmost composer button" sends the draft into the running agent
  in precisely the state a stop is wanted.

### ✓ Alternative: drive Claude Code directly (not wired)
Because `sessions.id == claude_session_id` and the worktree is a normal repo,
`claude --resume <id> -p "<prompt>"` from the relay would run the turn with zero
Conductor coupling. Trade-off: a second agent operating the same session/tree
can conflict with Conductor's own management and its UI won't reflect the turn
until it re-reads. Noted as a fallback, not the default.

---

## The two "unknowns to test first" from the plan — answered
- **CSP / outbound ws from the webview:** moot. The new architecture never
  injects anything into the webview, so there is no in-webview socket to permit.
- **Injection persistence across updates:** moot for the same reason. The only
  update-fragile surface is the AX prompt-field target, remapped in minutes.

## Suggested next steps
1. **Per-workspace targeting — solved** via the sidecar socket (see Writes ▸
   Sidecar IPC). `SidecarActuator` addresses the session directly; the AX-tree /
   `conductor://` route mapping is no longer needed.
2. **Validate the sidecar send live** on your own setup, then consider making
   `WRITE_STRATEGY=sidecar` the default. The safe read RPCs already confirm the
   socket + auth; a real `query` send just needs a live sanity check (it will
   inject a prompt into the target agent, so it wasn't auto-run).
3. File the Help ▸ Send Feedback request for a supported **local** control API —
   if Conductor blesses the sidecar verbs (or the `/v0` surface) for local
   workspaces, the fragile-IPC caveat disappears.
