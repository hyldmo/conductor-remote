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
  context-breakdown.ts  provider-neutral estimates for a chat's current context categories;
                  respects compaction/turn boundaries, excludes mirrored child-agent frames,
                  and sizes each full-history fork format
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
  staged-attachments.ts  files picked before a worktree exists; the ordinary first-prompt queue
                  or Workflow root binder moves them in before sending their tokens; a conservative
                  sweep removes week-old files absent from synced drafts, the ordinary delivery
                  queue, and Workflow runs
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
  mcp-tools.ts    the 23 MCP tools + a transport-agnostic JSON-RPC dispatcher; tools reach
                  the relay through an injected `call`, so both transports share one path
  mcp.ts          the stdio transport (conductor-remote mcp). HTTP lives in server.ts at
                  POST /mcp, which runs in-process and so is inside the UI lock natively
  git.ts          workspace diff + aggregate line stats vs target branch (incl. untracked via
                  --no-index), complete on-demand patches for the file open in the review UI,
                  plus the worktree's file list (GET /api/workspaces/:id/files) that decides
                  which file an agent named in a message becomes a link
  fork-workspace.ts  non-disruptive Git snapshot + restore for a split sent to a new workspace;
                  preserves source HEAD, index and working tree through short-lived private refs
  change-stats.ts bounded, background cache of git line stats for /api/state; working rows
                  refresh quickly while idle rows avoid spending four git calls every poll
  run-activity.ts cached live-process read for workspace Run badges; maps each resolved
                  worktree to Conductor's `run-run:<n>.sh` wrapper without delaying /api/state
  file-preview.ts parses source and raster-image paths an agent wrote (absolute, or ~) and
                  decides whether the relay may open them — the same answer whether or not
                  the file exists
  merge.ts        merge the workspace's open PR via `gh pr merge` (mirrors Conductor's Merge button)
  pr.ts           the one read that leaves this box: GitHub PR state, cached and never awaited
                  by /api/state; conflicts are computed locally with `git merge-tree`
  sidecar.ts      Conductor sidecar IPC client (JSON-RPC over unix socket)
  writes.ts       Actuator: AppleScript (default) + Sidecar (opt-in); uiTurn() serializes UI ops
                  locally and cooperates with the relay-wide cross-process SQLite lease;
                  merged-workspace Continue delegates the branch/store/chat transition to Conductor
  agent-config.ts two-pass cross-provider config: model-only write + DB receipt, then
                  reacquired effort/fast controls + final receipt (generic Plan stays available
                  to ordinary callers and remains outside Workflow role snapshots)
  model-cache.ts  the picker labels and starred default Conductor has shown us, keyed by
                  harness, so a workspace with no chat yet can still show the effective model
  conductor-settings.ts  surgical, atomic reads/writes of Claude/Codex new-chat effort
                  defaults in ~/.conductor/settings.toml; preserves every unrelated TOML line
  plan-usage.ts   prompt-free Claude/Codex CLI allowance reads → normalized rolling windows;
                  concurrent, single-flight and cached (Cursor/OpenCode report unavailable)
  tool-usage.ts   pairs saved tool calls/results by chat and call ID for 24h/7d/30d estimates;
                  includes archived/hidden chats, skips mirrored child internals and binary payloads
  tool-usage-service.ts + tool-usage-worker.ts  on-demand read-only SQLite scans off the HTTP
                  thread, serialized and cached for one minute; only names/counts/token estimates
                  leave the worker, never tool arguments or result text
  roles.ts        strict v1 global role config in stateDir()/roles.json; exact picker/provider
                  validation, immutable resolved snapshots, no Plan field
  workflow.ts     validates/freezes all three Workflow roles and builds the root/child/Baton
                  envelopes around the immutable objective; generic Plan is outside that snapshot
  workflow-machine.ts pure phase/capability/barrier rules: exploration before implementation,
                  delivered Batons before phase changes, and stable review
  orchestration-schema.ts  Drizzle source of truth for the relay-owned SQLite schema,
                  inferred row types, and derived Zod validators
  orchestration-schema.generated.ts  checked-in STRICT bootstrap SQL generated from that schema
  orchestration-db.ts  transactional state in stateDir()/orchestration.db: runs,
                  jobs/attempts, effects/attempts, hashed capabilities, idempotency, events,
                  relay identities, the cross-process UI lease, and ambiguity quarantine
  workflow-effect-runner.ts starts external UI helpers behind a private persisted-before-GO gate;
                  owns process-group identity and bounded termination for crash recovery
  workflow-coordinator.ts  deterministic Workflow lifecycle, effect receipts/reconciliation,
                  job ownership, recovery mutations, and secret-free phone projections
  relay-processes.ts discovers compatible UI-capable relay processes by PID/start identity
  delegations.ts  legacy worktree-local JSON job/session-role queue; accepted upgrade-era jobs
                  may drain, but ordinary new delegation intake is rejected
  session-poller.ts one two-second live-session read fanned out synchronously to notifications,
                  legacy delegation progress, and Workflow receipt observation; async listener
                  work cannot hold the clock
  sendonce.ts     the send memo: answers a repeated clientId with the first send's outcome
  firstprompt.ts  persisted queue for ordinary new-workspace first prompts, from setup on;
                  managed Workflow creation/effects belong to orchestration.db instead
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
                  / useContextBreakdown (on demand) / useRoles; dedicated Workflow start/recovery
                  mutations; ordinary useSendPrompt applies staged agent settings, then sends
  src/lib/        api client, types (re-export of src/wire.ts), format helpers, cn, composer
                  drafts (draft.ts), ready attachments and staged agent settings (agentDraft.ts), local-first host
                  preference sync (prefs.ts), read marks (read.ts, the unread this phone has
                  seen), pending sends and stable Workflow mutation client ids (pending.ts),
                  push (permission/subscribe/reconcile), the unlock link a locked Mac gets
                  (lock.ts), transcript-merge (folds each tool result onto the call it answers,
                  identity intact), transcript-tree (rebuilds native child frames and gives each
                  spawned agent a durable virtual subtab), transcript-actions (where a Fork control may sit), highlight
                  (eleven languages, registered one at a time), fileMentions (turns `src/git.ts`
                  in a message into a source link, worktree file list as the existence check;
                  explicit raster links and attachment pills also resolve ignored project-relative
                  files, while absolute and ~ paths pass through for the relay to allow), clipboard (copyText,
                  behind the Copy on a response and on every fenced block), commands (the ⌘K
                  palette's registry: each view registers the actions it owns while mounted,
                  one matcher and one shortcut dispatcher read the flat list)
  src/components/ Header, WorkspaceList, SessionView, Transcript, Markdown + Code, DiffView
                  (changed/all file rail with patch/source viewer), SourceLines,
                  Composer (AgentBar renders inside its card, with AgentControls / ModelPicker),
                  RolesSettings, WorkflowModePill, DelegationPipeline, QueueBubble,
                  WorkspaceMenu (the status groups, plus Archive), MergeBanner (merge + continue), MessageNav,
                  DevServerControls, ContextBreakdownSheet, SearchSheet + SearchPane + CommandResults (one
                  ⌘K box for chats and actions), ArchivedChat (a hit whose
                  worktree is gone), NewWorkspaceSheet, PlanUsageSheet (the Models panel:
                  provider defaults plus usage, with ToolUsageSection ranking tool context
                  by total/per-call/largest payload and filtering by provider/period), LogsSheet, TokenGate, QRCode +
                  QRScanner, ReloadPrompt, ui, and ConnectSheet
                  (the Notifications switch with "send a test", plus the Mac section: keep-awake
                  windows and the fallback-network picker). Patch.tsx renders a unified diff for
                  both the workspace diff and an edit step's result
  src/store.ts    zustand: token + connection status + drafts (text + ready attachments)
                  + staged agent settings + Workflow attempt ids + read marks
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
                 + generate-orchestration-schema.ts (snapshot-free Drizzle export; `yarn db:schema`)
tests/           Vitest unit, contract, concurrency, filesystem and shell integration tests
dist/            built PWA (gitignored) — what the relay serves
dist-node/       compiled relay (gitignored) — src/ + service.ts/qr.ts → JS for the npm tarball
```

## Deterministic Workflow and legacy delegated chats

`roles.json` is global configuration, not run state. Workflow preflight resolves exact
picker labels and freezes the complete planning, exploration, and implementation role
snapshot—provider, model, effort, Fast, and private preamble—so later role edits affect
only later runs. The two child roles must remain cross-provider from the planning role.
Generic per-chat Plan controls are deliberately outside that snapshot: they remain
visible and independent where Conductor supports them, and Workflow adds no special
Plan policy or explanatory copy. The root's first prompt includes a compact catalog of
the frozen role names, model labels, and responsibilities. It does not ask the agent to
call `list_roles`, because that tool reads mutable defaults for future runs rather than
the active run's snapshot.

The only start boundary is the authenticated PWA's `POST /api/workflows`. New workspace
and pristine existing-chat targets use its tagged union; ordinary `POST /api/workspaces`
and `POST /api/sessions/:id/prompt` carry no Workflow bit, and MCP exposes no start
operation. Before any Conductor mutation, one SQLite transaction in
`stateDir()/orchestration.db` records the immutable objective, client id plus canonical
request hash, frozen roles, target/baseline evidence, prepared first effect, and a dormant
logical `explore:0` job. This is a separate WAL database owned by the relay; the
Conductor database stays read-only.

The coordinator advances
`creating_workspace → binding_root → pending_root → exploring → planning → implementing → reviewing`.
A delivered root receipt activates the dormant bootstrap explorer, so one tracked
explorer is mechanical rather than a suggestion. The planner can request additional
independent explorers. `delegate_task` is accepted only from that run's root with a
hashed, causally delivered capability for its exact cycle, revision, phase, and next
role. Every current exploration Baton must exist as a durable parent message—not merely
an accepted outbox row—before implementation opens. Implementation Batons likewise
lead to `reviewing`, which stays stable until the planner requests another permitted
tracked pass or the phone explicitly marks the run complete.

Jobs and UI effects keep logical identity across physical attempts. A process-local
priority queue still orders calls inside one relay; a SQLite lease serializes UI access
across relay processes. External helpers start behind a private gate only after their
PID/start identity and the effect's `mayExecute` boundary are durable. A successor uses
positive receipts and saved baselines to reconcile an abandoned effect. It may resume a
provably pre-dispatch prepared effect; a deterministic blocked failure exposes phone
Retry, while an effect that may have happened stays `blocked` rather than being guessed
or replayed. Cancellation tombstones work without closing tabs or stopping turns; the
durable wake query keeps only cancelled runs with unresolved dispatched effects, outbox
receipts, or delivered child turns under observation. A later receipt or child result is
recorded for audit without reopening the run, returning a Baton, or scheduling more work,
including after a relay restart.

`WorkflowRunWire` exposes only the bounded, secret-free projection needed by the PWA:
phase, frozen public roles, guaranteed/extra job counts, navigation ids, sanitized error,
adoption candidates, and allowed actions. `StateResponse.workflows` carries accepted
runs even before they bind to a workspace; a workspace projection is only a convenience
after binding. Once the run is terminal, `workspace.workflow_identity` retains only its
id, phase, and frozen public roles so the sidebar's Workflow/role icon stack does not
fall back to whichever chat model happens to be active; pre-coordinator workspaces use
the old un-delegated planning-root marker as a narrow upgrade fallback. The phone owns
idempotent Retry, explicit candidate adoption, separately
confirmed risky replay, non-destructive Cancel, and stable-review Complete (only after
an implementation Baton and with no outstanding job). The pipeline uses explicit
Workflow ids for child tabs; it never
infers managed ownership from arbitrary role chips or delegation records.

The planner's instruction forbids code edits and the phase gates ensure tracked
implementation goes through the implementation role. That is an orchestration and
prompt contract, not an OS sandbox: an ordinary Conductor root still has filesystem
tools, and the relay cannot remove them from an already-running chat.

`delegations.ts` now exists only for upgrade compatibility. Previously accepted JSON
jobs under `.context/delegations/` may finish and retain their legacy role-chip/session
metadata, but ordinary new delegation intake is rejected. New `delegate_task` requests
must carry a valid Workflow id and phase capability and are persisted in
`orchestration.db`, never in the legacy queue.

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
