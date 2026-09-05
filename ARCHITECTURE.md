# Architecture — the map

Where each file sits and what it owns, plus how to re-derive Conductor's
internals when an update breaks a read or a write. The *why* behind these
choices lives in [CLAUDE.md](./CLAUDE.md) (the mental model and the traps) and
[FINDINGS.md](./FINDINGS.md) (the reverse-engineering the design rests on);
[README.md](./README.md) covers installing and running it.

## File map

```text
src/                     Node relay; source runs as .ts, npm ships emitted dist-node/ JS
  server.ts              executable startup: create services/server, listen, start timers and queues
  mcp.ts                 stable stdio MCP entrypoint (conductor-remote mcp)
  config.ts              paths, relay port/bind, token, write strategy, built PWA directory
  pkg-root.ts            packageRoot(): find package.json from source or emitted modules
  db.ts                  one read-only Conductor SQLite handle; slow-query logs omit parameters
  routes.ts              shared API path builders and matching patterns
  wire.ts                shared API response/request shapes; types only
  shared.ts              browser-safe values: titles, query tokens, transcript rendering, lock phrase
  settings.ts, prefs.ts   relay settings and durable sync of PWA read marks/draft intent
  http/
    services.ts          composition root: construct each service once and inject shared dependencies
    router.ts            token gate, client priority, route dispatch, common error handling
    router-types.ts      handler contract and NOT_HANDLED sentinel
    services/
      base.ts            own DBs, Reads, SessionPoller, actuator, caches, role store, shared UI lease
      delivery.ts        prompt budgets/receipts, chat opening, first-prompt and parked queues
      delegations.ts     ordinary-child UI adapters, completion observation, DelegationQueue
      workflow.ts        coordinator adapters and managed effect dispatch
      workflow-probes.ts exact root/delivery/effect evidence reads and validation
      workflow-state.ts  HTTP error/public state projection helpers
      mcp.ts             Streamable HTTP /mcp transport, using the same registry as stdio
      voice.ts           voice listener/broker assembly and call-scoped relay tools
      files.ts           static PWA, attachment and tool-image responses
      responses.ts       authentication, body limits, conditional JSON, redaction/compression
    routes/              state, system, workspaces, create-workspace, sessions, prompts,
                         files, workflows, voice; injected services, no startup side effects
  reads/
    repository.ts        Reads facade over the same read-only ConductorDb
    workspaces.ts        workspace/repo reads, search targets, archive metadata
    sessions.ts          live/closed sessions, turn-start SQL, status snapshots
    messages.ts          transcript rows plus full outbox snapshot and delivery receipts
    worktrees.ts         resolve worktree paths; types.ts holds read-side contracts
    background-tasks.ts  process-gated open SDK task set, shared cached process snapshot
    session-poller.ts    one two-second base read fanned out to notifications and orchestration
  writes/
    types.ts             Actuator and targeting/result contracts
    actuator.ts          AppleScript default and opt-in Sidecar actuator selection
    ui-lock.ts           one bounded process-local priority queue; shared SQLite lease/dispatch hook
    targeting.ts         workspace links, pane/tab assertions and restart guard injection
    runner.ts            assemble/run AppleScript with bounded execution and temporary-file cleanup
    guards.ts            retry/lock/pre-dispatch predicates and the node-side lock probe
    chats.ts             create, close, restore and stop exact chats
    workspaces.ts        create, archive, Continue, status and Run/Stop actions
    agent-options.ts     model/effort/Fast/Plan controls and menu parsing
    system.ts            restart and Instant Hotspot actions
    sidecar.ts           optional JSON-RPC client over Conductor's Unix socket
    applescript/
      source.ts          ordered manifest and loader for one assembled AppleScript program
      *.applescript      nine editable parts: window, workspace/chat targeting, composer,
                         Run tasks, lifecycle, agent options, workspace status, hotspot
  orchestration/
    persistence/
      db.ts              OrchestrationDb facade; connection.ts owns the one writable handle/transaction depth
      schema.ts          Drizzle schema, inferred rows and Zod validators
      schema.generated.ts checked-in STRICT bootstrap SQL; generated, never hand-edited
      runs.ts            acceptance, guarded transitions and cancellation
      jobs.ts, job-attempts.ts       logical job claims and physical attempts
      effects.ts, effect-transitions.ts, effect-recovery.ts
                         prepared effects, dispatch boundaries, receipts and abandoned-owner recovery
      capabilities.ts, idempotency.ts, events.ts
                         hashed authority, stable request results and transactional audit events
      relays.ts, ui-lease.ts, quarantine.ts
                         process identities, cross-process UI exclusion and unresolved-effect holds
      records.ts, codecs.ts, projections.ts
                         internal reads/row validation and bounded secret-free phone views
      types.ts, values.ts, errors.ts focused persistence contracts and validation helpers
    workflow/
      coordinator.ts     WorkflowCoordinator facade; one wake map shared by all lifecycle operations
      start.ts, wake.ts, root.ts      intake, coalesced advancement and root binding/delivery
      job-dispatch.ts, job-results.ts child opening/configuration/send, outcomes and Baton barriers
      commands.ts        scoped delegation, Retry, Adopt, Replay, Complete and Cancel
      effects.ts, effect-recovery.ts durable UI dispatch and positive-receipt reconciliation
      effect-runner.ts   external helper gate: persist process identity before GO; bounded group cleanup
      machine.ts         pure phase/capability/barrier rules
      prompts.ts         freeze configured roles and build root/child/Baton envelopes
      http.ts            strict Workflow request parsing
      state.ts, helpers.ts, types.ts, errors.ts shared context, guards and contracts
    delegation/
      intake.ts          validate ordinary-chat tasks and Workflow ownership before persistence
      queue.ts           one ordinary-job producer, retries and stable completion observations
      store.ts, codec.ts worktree-local JSON job/session-role storage and strict decoding
      prompt.ts, types.ts focused child assignment and queue adapter contracts
  agents/                agent-config.ts: model receipt before effort/Fast; model-cache.ts:
                         observed picker labels; roles.ts: strict global roles.json;
                         conductor-settings.ts: surgical new-chat defaults in settings.toml
  delivery/              firstprompt.ts, parked.ts, sendonce.ts: durable ordinary prompt queues
                         and the in-process repeated-client-id send memo
  dev-server/            controller.ts owns preview/forward state; proxy.ts tunnels requests;
                         ports.ts allocates owned HTTPS mounts; processes.ts owns the shared ps cache;
                         run-configs.ts, preview-urls.ts and run-activity.ts resolve named Run tasks
  files/                 attachments.ts, staged-attachments.ts, file-preview.ts and icons.ts:
                         real/staged attachment bytes, allowed source/image paths and repo icons
  git/                   diff.ts, change-stats.ts, fork-workspace.ts, pr.ts, merge.ts:
                         worktree diffs/stats, nondisruptive snapshots and PR actions
  search/                coordinator.ts owns query grammar/folding; worker.ts owns the synchronous
                         FTS sidecar handles so backfill/ranking cannot block HTTP
  transcript/            parser.ts decodes provider frames and tool images; cursor.ts builds opaque
                         message pointers; context-breakdown.ts estimates provider-neutral context
  usage/                 plan-usage.ts queries CLI subscription windows without prompts;
                         tool-usage.ts/service/worker keep payload scans off the HTTP thread
  notifications/         notify.ts: TurnWatcher + subscription store; webpush.ts: VAPID/encryption
  host/                  Tailscale/Wi-Fi, self-update/ingress watchdog, logs, relay process identity,
                         UI-lease watchdog and the nosleep controller/root-helper source
  voice/                 scoped fleet/current-chat tools, call broker/history, SIP/WebRTC transports,
                         caller gate, previews, secrets and shared speech bounding
web/                     React PWA; Vite root
  index.html             self-heal.js loads before the module bundle to recover a dead shell
  src/main.tsx, app.tsx   QueryClient/router, token gate, persistent voice provider and ReloadPrompt
  src/store.ts           Zustand state for connection, drafts, settings intent and device state
  src/hooks/             browser gestures; workspace/agent/review/search queries; transcript/send;
                         push lifecycle; preferences and Workflow mutations
  src/components/
    session/             SessionView keeps view state; SessionTabs, DiffPanel, notices, Composer
    transcript/          Transcript shell/grouping, entries, tool details, activity, menus, Markdown/Code
    workspaces/          list/grouping, cards/filter controls, creation, Run controls and merge/Continue
    orchestration/       workflow summaries/warnings, role editor, agent subtabs and delegation bubbles
    agents/, review/     model/usage/context controls and shared patch/source viewers
    settings/            ConnectSheet and independent theme/notification/Mac rows, token/QR/log sheets
    search/, voice/      command/chat search and call/history controls
    Header.tsx, ui.tsx, ReloadPrompt.tsx, FileIcon.tsx, BetaBadge.tsx
                         small cross-feature shell and display primitives
  src/lib/               API/auth token, shared-type re-export, formatting, preference/read sync,
                         push, commands and file mentions; prompts/, transcript/, syntax/, voice/
                         group cohesive client helpers without importing relay-only modules
scripts/
  service.ts             stable LaunchAgent CLI entry: apply flags, then import the command implementation
  service/               commands, installation, LaunchAgent plist, network/voice exposure,
                         config/environment and status presentation
  qr.ts, nosleep.ts, nosleep-setup.ts, gen-icons.ts
                         phone URL QR, keep-awake commands/root setup and PWA icons
  check-applescript.ts, copy-applescript.ts, check-imports.ts
                         assembled-program validation, matching package assets and browser boundaries
  generate-orchestration-schema.ts  snapshot-free Drizzle export (yarn db:schema)
tests/                   suites grouped by domain; orchestration/{persistence,workflow,delegation},
                         writes/, reads/, voice/, session/, transcript/, workspaces/ and other peers
public/                  repo-root icon assets, self-heal.js and push-sw.js
numux.config.ts          yarn dev: Vite + relay, on the workspace's allocated ports
dist/                    built PWA; gitignored and served by the relay
dist-node/               emitted relay/service JS plus manifest-listed AppleScript assets; gitignored
```

`src/server.ts` is the executable boundary. It calls `createRelayServices()` once,
passes the resulting services to `createRelayServer()`, then starts listeners,
pollers and recovery loops. Route modules receive those dependencies; importing a
route or service implementation does not start another server. `src/http/router.ts`
keeps authentication, UI priority and error handling around every API handler.

Splitting files does not split ownership. `src/db.ts` and `reads/repository.ts` keep
the Conductor connection read-only. `OrchestrationDb` delegates to persistence
operations on one `PersistenceConnection`, including its nested transaction depth.
`WorkflowCoordinator` passes one context and wake map through the root, job and
effect lifecycles. The composition root constructs the first-prompt, parked-prompt
and ordinary-delegation queues once; none of their consumers starts another
producer. All UI actions import `writes/ui-lock.ts`, whose process-local priority
queue also acquires the single cross-process lease in orchestration persistence.

The AppleScript parts are editing boundaries inside one program. The manifest in
`src/writes/applescript/source.ts` defines their exact order for runtime loading,
compile/handler checks and package copying. The split preserved the original
program byte for byte; joining adds no separators. Add a source part to the
manifest, keep cross-part handler checks intact, and copy assets alongside the
emitted loader rather than relying on a root-only shell glob.

`scripts/service.ts` applies flags before dynamically importing
`scripts/service/commands.ts`: `service/environment.ts` captures relay/voice ports
at module load. An eager import would freeze ambient settings before CLI overrides
were applied. The executable entry paths remain stable for `bin/cli.js` and live
relay-process detection.

Around 600 code lines, excluding comments and blanks, is a signal to check a file's
responsibilities. Split cohesive behavior, preserve shared state and transactions,
and group related tests with it. Prefer imports from the owning module; retain a
facade only when it provides a real interface such as `Reads` or `OrchestrationDb`,
not a barrel stub at an obsolete path.


## Deterministic Workflow and lightweight delegated chats

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
independent explorers. Workflow-scoped `delegate_task` is accepted only from that run's root with a
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

Ordinary chats use a lightweight path through `src/orchestration/delegation/intake.ts`
and `src/orchestration/delegation/queue.ts`, with JSON persistence in `store.ts` and
validation in `codec.ts` beside them.
`delegate_task` without either Workflow credential posts to `/api/sessions/:id/delegate`.
Intake rejects unknown fields, missing or same-provider roles, invalid transcript cuts,
and any parent owned by an active Workflow before enqueue. If Workflow ownership cannot
be read because the orchestration schema is incompatible, intake stays closed. Supplying
either Workflow credential selects the managed path and requires both; a failed managed
call never falls back to ordinary delegation.

The ad hoc queue persists each task and frozen role under `.context/delegations/`, then
opens/configures/sends a child through the shared background-priority UI lock. Children
can run concurrently; their creation does not create a Workflow or assign a planning
role to the parent. `sessions.json` records `parentSessionId` on each child so completed
subtabs stay attached to their parent after the successful job file is removed. Older
role documents without a parent retain the existing planning-parent display fallback.
The child instruction keeps transcript content as context and prevents an ordinary task
from launching a Workflow. Its task and output format come from the configured preamble
and assignment; the relay does not infer editing permissions from the role's name or
impose a Baton format. The shipped role preambles request Batons, and custom roles may
request other formats. `list_roles` exposes those instructions alongside all set controls.
Restart semantics remain the existing queue's at-least-once side effects and receipt-based
Baton delivery; managed jobs keep the coordinator's stronger effect reconciliation.

Role validation and the role editor share `currentModelCatalog`: each provider's labels
come from the newest complete menu containing that provider. The observing chat's harness
does not own every row. A menu for one provider cannot invalidate another provider's labels, while
a newer menu for the same provider retires renamed labels. Explicitly partial selections
(`snapshotAt: null`) and legacy entries with unknown provenance only add evidence for
individual labels; they cannot erase other choices. A later confirmed menu supersedes
that evidence. Remembering another selection never promotes a legacy entry into a menu.
Selections retain their own timestamps, and the saved menu retains its original labels,
so selecting one row neither revives an earlier retired choice nor changes what was
actually observed in that menu.

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
