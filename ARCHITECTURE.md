# Architecture — the map

Where each file sits and what it owns, plus how to re-derive Conductor's
internals when an update breaks a read or a write. The *why* behind these
choices lives in [CLAUDE.md](./CLAUDE.md) (the mental model and the traps) and
[FINDINGS.md](./FINDINGS.md) (the reverse-engineering the design rests on);
[README.md](./README.md) covers installing and running it.

## File map

```
src/              Node relay (dev: run as .ts via Node type-stripping; tarball: compiled to dist-node/)
  server.ts       HTTP router: /api/* (token-gated) + static PWA + SPA fallback
  config.ts       paths, port, Tailscale bind, token, write strategy, dist dir
  pkg-root.ts     packageRoot(): walk up to package.json (works from src/ and dist-node/src/)
  db.ts           read-only node:sqlite handle to conductor.db; logs >100ms queries without params
  reads.ts        workspaces / sessions / messages + worktree resolution
  icons.ts        repo-icon resolution, mirroring Conductor's own precedence (repos.icon →
                  a known filename in the repo root → the GitHub owner's avatar → a monogram)
  transcript.ts   Claude Code SDK stream JSON → phone-renderable entries, and back out to
                  markdown (renderTranscript: prose always, thinking/tools per flag). A tool's
                  output travels as its own entry naming the call (`toolUseId`), capped; the
                  markdown render prints the call and leaves the output behind. Reads every
                  result shape — text, edit diffs, tool_reference lists — and numbers a row's
                  images for GET /api/tool-images/:reference (toolImageAt does that lookup)
  attachments.ts  writes a real Conductor attachment from outside Conductor: the file under
                  .context/attachments/<id>/, and the @⟦name⟧(path) token the composer parses
  staged-attachments.ts  files picked before a worktree exists; the first-prompt queue moves
                  them in before it sends the token that refers to them; a conservative sweep
                  removes week-old files absent from both synced drafts and the delivery queue
  search.ts       main-thread facade/query grammar for chat search; folds chunk hits into workspaces
  search-worker.ts owns both synchronous SQLite handles for the FTS5 sidecar
                  (stateDir()/search.db), so backfill, lock waits and ranking cannot stall HTTP
  chat-cursor.ts  the opaque pointer one message in a chat is addressed by, so the MCP
                  contract never exposes a rowid an agent would do arithmetic on
  wire.ts         the /api contract: every shape that leaves the relay, declared once (types only)
  routes.ts       the /api paths, declared once — one pattern builds the client path and the
                  relay's matching regex, so the two cannot drift
  shared.ts       what both sides must compute identically (workspaceTitle, query tokens,
                  the locked-Mac phrase) — the one module web/ may import as a *value*
  mcp-tools.ts    the 26 MCP tools + a transport-agnostic JSON-RPC dispatcher; tools reach
                  the relay through an injected `call`, so both transports share one path
  mcp.ts          the stdio transport (conductor-remote mcp). HTTP lives in server.ts at
                  POST /mcp, which runs in-process and so is inside the UI lock natively
  git.ts          workspace diff + aggregate line stats vs target branch (incl. untracked via
                  --no-index), plus the worktree's file list (GET /api/workspaces/:id/files)
                  that decides which file an agent named in a message becomes a link
  fork-workspace.ts  non-disruptive Git snapshot + restore for a split sent to a new workspace;
                  preserves source HEAD, index and working tree through short-lived private refs
  change-stats.ts bounded, background cache of git line stats for /api/state; working rows
                  refresh quickly while idle rows avoid spending four git calls every poll
  file-preview.ts parses source and raster-image paths an agent wrote (absolute, or ~) and
                  decides whether the relay may open them — the same answer whether or not
                  the file exists
  merge.ts        merge the workspace's open PR via `gh pr merge` (mirrors Conductor's Merge button)
  pr.ts           the one read that leaves this box: GitHub PR state, cached and never awaited
                  by /api/state; conflicts are computed locally with `git merge-tree`
  sidecar.ts      Conductor sidecar IPC client (JSON-RPC over unix socket)
  writes.ts       Actuator: AppleScript (default) + Sidecar (opt-in); uiTurn() serializes UI ops;
                  merged-workspace Continue delegates the branch/store/chat transition to Conductor
  agent-config.ts two-pass cross-provider config: model-only write + DB receipt, then
                  reacquired effort/fast controls + final receipt (generic Plan support stays
                  available to existing callers but delegated roles never pass it)
  model-cache.ts  the picker labels and starred default Conductor has shown us, keyed by
                  harness, so a workspace with no chat yet can still show the effective model
  conductor-settings.ts  surgical, atomic reads/writes of Claude/Codex new-chat effort
                  defaults in ~/.conductor/settings.toml; preserves every unrelated TOML line
  plan-usage.ts   prompt-free Claude/Codex CLI allowance reads → normalized rolling windows;
                  concurrent, single-flight and cached (Cursor/OpenCode report unavailable)
  roles.ts        strict v1 global role config in stateDir()/roles.json; exact picker/provider
                  validation, immutable resolved snapshots, no Plan field
  workflow.ts     validates/freezes the planning role and wraps a workflow's first objective
                  with explicit delegation authority; emits no Plan setting
  delegations.ts  strict worktree-local job/session-role codecs + guarded persisted queue;
                  active jobs live under .context/delegations/ and successful jobs are removed
                  after their Baton receipt while session role identity remains
  session-poller.ts one two-second live-session read fanned out synchronously to notifications
                  and delegation progress; async listener work cannot hold the clock
  sendonce.ts     the send memo: answers a repeated clientId with the first send's outcome
  firstprompt.ts  persisted queue that tags a workflow root, applies its frozen settings, and
                  delivers a new workspace's first prompt, from setup on
  parked.ts       persisted queue for prompts that hit the lock screen — delivers on unlock, pushes the receipt
  dev-server.ts   URL-first Conductor Run previews + live cross-process advertisements +
                  per-port tailnet-only HTTPS forwards
  notify.ts       status-transition watcher subscribed to SessionPoller + subscription store
                  (~/…/conductor-remote/push.json, 0600)
  webpush.ts      Web Push protocol: VAPID (ES256) + aes128gcm payloads, node:crypto only
  logbuf.ts       console capture (ring + stamped stdout) + log-file tail → GET /api/logs, token redacted
  autoupdate.ts   self-update from npm; exit()s to reload, so both queues persist to disk
  tailscale.ts    magicdns name, expose posture (funnel|serve), tailscale binary, relay port,
                  serve-status parser (which HTTPS port fronts the relay, and who holds the rest)
  funnel-watchdog.ts  end-to-end probe of the PUBLIC ingress; re-registers a stale funnel, and
                  can move the Mac to a fallback network when it has no route at all
  settings.ts     relay preferences the phone edits (fallback SSIDs, autoRejoin) → stateDir()/settings.json
  prefs.ts        durable sync peer for PWA read marks + draft text/agent/attachment intent
                  → stateDir()/prefs.json (attachment bytes remain in their existing host paths)
  wifi.ts         networksetup reads + the one narrow write (join a network macOS already knows).
                  All async: it is slowest exactly when the link is wedged, and the relay is one thread
  nosleep-helper.ts  the root half in one place: the shared POSIX-sh body, the helper file it is
                  installed as, the sudoers drop-in, and helperReady() (runs the real path under sudo -n -k)
  nosleep.ts      arming lid-closed wakefulness from the phone: detached spawn, pidfile discovery
                  across relay restarts, liveness read through EPERM — and the `pmset sleepnow`
                  that ends a window for real (a shut lid never replays its close event)
  conductor.applescript  the UI script writes.ts runs; a real file, read as a sibling of the
                  emitted module, so build:node copies it beside the JS
web/              React PWA (Vite root)
  index.html      loads /self-heal.js synchronously (before the module bundle) so it can catch a dead shell
  src/main.tsx    root: QueryClient + Router (SW registered in ReloadPrompt, not here)
  src/app.tsx     routes (/ list, /w/:id session) + token gate; mounts ReloadPrompt above the gate
  src/hooks.ts    useWorkspaces / useDiff / useTranscript (incremental poll) / useModels (model list, SWR)
                  / useRoles; useSendPrompt applies staged agent settings, then sends
  src/lib/        api client, types (re-export of src/wire.ts), format helpers, cn, composer
                  drafts (draft.ts), ready attachments and staged agent settings (agentDraft.ts), local-first host
                  preference sync (prefs.ts), read marks (read.ts, the unread this phone has
                  seen), pending sends (pending.ts, optimistic bubbles restored across a reload),
                  push (permission/subscribe/reconcile), the unlock link a locked Mac gets
                  (lock.ts), transcript-merge (folds each tool result onto the call it answers,
                  identity intact), transcript-actions (where a Fork control may sit), highlight
                  (eleven languages, registered one at a time), fileMentions (turns `src/git.ts`
                  in a message into a source link, worktree file list as the existence check;
                  explicit raster links and attachment pills also resolve ignored project-relative
                  files, while absolute and ~ paths pass through for the relay to allow), clipboard (copyText,
                  behind the Copy on a response and on every fenced block)
  src/components/ Header, WorkspaceList, SessionView, Transcript, Markdown + Code, DiffView,
                  Composer (AgentBar renders inside its card, with AgentControls / ModelPicker),
                  RolesSettings, WorkflowModePill, DelegationPipeline, QueueBubble,
                  WorkspaceMenu (the status groups, plus Archive), MergeBanner (merge + continue), MessageNav,
                  DevServerControls, SearchSheet + SearchPane, ArchivedChat (a hit whose
                  worktree is gone), NewWorkspaceSheet, PlanUsageSheet (the Models panel:
                  provider defaults plus usage), LogsSheet, TokenGate, QRCode +
                  QRScanner, ReloadPrompt, ui, and ConnectSheet
                  (the Notifications switch with "send a test", plus the Mac section: keep-awake
                  windows and the fallback-network picker). Patch.tsx renders a unified diff for
                  both the workspace diff and an edit step's result
  src/store.ts    zustand: token + connection status + drafts (text + ready attachments)
                  + staged agent settings + read marks
                  + this device's push subscription
public/           icon.svg source + PWA PNGs (repo-root so Conductor's icon lookup finds them; `yarn gen:icons`)
  self-heal.js    HTML-level stale-client watchdog (see the PWA self-update trap in CLAUDE.md)
  push-sw.js      push / notificationclick handlers, pulled into the generated SW by workbox.importScripts
numux.config.ts  `yarn dev` — Vite + relay in one numux TUI, on per-workspace ports
scripts/         gen-icons.ts + service.ts (macOS LaunchAgent install/uninstall/status)
                 + qr.ts (dep-free QR of the phone URL, printed by service.ts)
                 + nosleep.ts (the `nosleep [duration|setup|status]` entrypoint)
                 + nosleep-setup.ts (installs the root helper + the scoped sudoers rule)
                 + check-{applescript,imports}.ts (repository source/toolchain validators)
tests/           Vitest unit, contract, concurrency, filesystem and shell integration tests
dist/            built PWA (gitignored) — what the relay serves
dist-node/       compiled relay (gitignored) — src/ + service.ts/qr.ts → JS for the npm tarball
```

## Delegated role chats

Roles and jobs deliberately have different lifetimes. `roles.json` is global relay
configuration. Intake requires one exact label from the deduplicated cached picker,
derives its provider from that label, rejects the parent's provider, and freezes the
complete role onto a job under the workspace worktree. Cache groups name the harness
where a whole picker snapshot was observed; they do not claim ownership of its rows.
Editing the role later therefore changes only future jobs.

The one `DelegationQueue` advances jobs through `queued → opening → configuring →
sending → running → returning → returned`. UI stages are background-priority clients
of the existing process-local `uiTurn`; there is no second scheduler. A locked screen
or saturated UI queue costs no attempt, while three real failures leave an actionable
`failed` file. Side effects are at-least-once across relay restarts. In particular, a
queued Baton persists its pre-dispatch transcript cursor/text and subsequent ticks
only seek that exact eventual user row instead of dispatching a second copy.

Completion needs the child to be idle, have no process-gated background task, and
contain a fresh assistant row after the delegated prompt. The same observation must
survive two poll ticks. `error` is the only other outcome; a question is ordinary
successful Baton prose for the parent to interpret. Conductor Plan mode is neither
stored nor applied nor read as completion state by this subsystem.

Successful job files disappear after the parent receipt. The worktree's separate
`.context/delegations/sessions.json` remains, which is why role chips survive on both
tabs until the workspace itself is archived.

Workflow mode is only an entry point into that same machinery. Both New workspace and
an untouched `+` chat send `workflow: true` instead of any explicit
model/effort/plan/fast patch. `workflow.ts` validates and freezes the global `planning`
role and builds a root prompt that records the user's delegation authorization. For a
new workspace that happens before the deep link creates anything; the first-prompt
queue persists the role alongside the prompt, waits for the real session and worktree,
writes the root assignment to `sessions.json`, then applies model/effort/fast and sends.
For an existing pristine chat, the send route checks that it is idle and has no user
row, writes the same assignment, then configures and sends inside the request's
idempotent send intent. Both orderings make the planning chip durable before work
becomes visible. Neither sets nor reads Conductor Plan mode.

## Re-deriving Conductor internals (if a Conductor update breaks something)

Conductor's on-disk layout and sidecar IPC are not public APIs. If a read breaks:

```bash
DB="$HOME/Library/Application Support/com.conductor.app/conductor.db"
sqlite3 "file:$DB?mode=ro" ".schema"
sqlite3 "file:$DB?mode=ro" "SELECT state,COUNT(*) FROM workspaces GROUP BY state"
```

If the **sidecar** write breaks, re-derive from `conductor-runtime`
(`~/Library/Application Support/com.conductor.app/bin/.internal/`):
`strings conductor-runtime` and grep for `conductor-sidecar-v2` (socket path),
`authenticateRequest` / `sendUserMessageRequest` / `p.literal("query")` (zod
schemas), and `addMethod(` in the `handleConnection` region (JSON-RPC methods).
The socket is newline-delimited JSON-RPC 2.0; local auth is `{userId:"local",
auth:"local"}`.

Key read facts: `workspaces.state='ready'` = live; `sessions.status` ∈
{working, idle, error}; `session_messages.content` is Claude Code SDK stream JSON
for assistant/system rows and plain text for dispatched user prompts; current
queued prompts live in `session_messages_outbox` (`mode='queue'`, text inside
`delivery_payload.message`) and move into `session_messages` only when dispatched;
the old `queue_order` set + `sent_at` null shape is legacy compatibility; worktrees at
`<workspacesRoot>/<repo.name>/<directory_name>`.
