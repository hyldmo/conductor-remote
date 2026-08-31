# Handover — continue here

Snapshot for picking this up cold (last updated 2026-08-06). Read
[README.md](./README.md) for usage and [FINDINGS.md](./FINDINGS.md) for the
reverse-engineering that shaped the design.

## Where it stands

A complete, installable **PWA** (React 19 · Vite 7 · Tailwind v4 ·
`vite-plugin-pwa` · TanStack Query · Zustand · Biome) served by a dependency-free
**Node relay**. Built and verified against a live Conductor on macOS.

- **Reads — done and working.** SQLite (`conductor.db`) + `git` per worktree.
  Verified end-to-end against the live app: 47 workspaces with status/model/
  branch (context % belongs to the *chat* and rides on the chat tab, since 14 of
  the 49 live workspaces here hold several and one runs 28 / 85 / 49 / 29 at
  once), a 136-message transcript parsed into user/assistant/tool
  entries, diff vs target branch (incl. untracked), token auth (401 without),
  static PWA + SPA deep-link fallback, manifest + service worker + icons.
- **Writes — two strategies behind the `Actuator` interface:**
  - `applescript` (**default**): opens the target's own Conductor link
    (`conductor://workspace?id=…&session=…`, the one its row menu copies under
    "Copy link"), then confirms the pane and the chat tab through Accessibility
    and writes the composer's `AXTextArea` directly. Pressing the sidebar
    `AXLink` and the Cmd+K palette remain the fallback. The same path can change
    the chat's model / effort / plan / fast (`POST /api/sessions/:id/agent`);
    values are read from the DB. Stopping a running turn
    (`POST /api/sessions/:id/stop`) rides the same focus-and-assert path and then
    presses Conductor's own **`⌘⇧⌫` "Cancel agent"** — a keystroke rather than the
    composer's stop button, which exposes no accessible name and sits beside the
    send button whenever the box has a draft.
  - **deep links** carry two of the writes now: `POST /api/workspaces` fires
    `conductor://prompt=…&path=…` to *create* a workspace, and the send path
    fires `conductor://workspace?id=…&session=…` to *focus* one — no
    Accessibility, no keystrokes for either. Focus by link measured ~2s against
    ~18s for the sidebar/palette path it replaced.
  - `sidecar` (**opt-in**, `WRITE_STRATEGY=sidecar`): precise per-session send
    over Conductor's dispatch socket. Socket + local auth + JSON-RPC protocol
    **validated with safe read RPCs**; a real `query` send is implemented but not
    auto-run (it would inject into a live agent). See FINDINGS ▸ Writes.
- **Push notifications — done.** `src/notify.ts` polls `sessions.status` for
  `working → idle` (a turn ended: finished / asked a question / hit a permission
  prompt) and `→ error`, then Web Pushes the phone. Protocol (`src/webpush.ts`)
  is VAPID + `aes128gcm` on `node:crypto` — no dependency added. Verified: the
  encryption round-trips against a hand-written user-agent decryptor, the ES256
  JWT verifies against the advertised key, and an end-to-end rig (a stand-in push
  service + a stubbed `Reads`) confirmed one push per confirmed transition, none
  for the baseline tick, and none for a status that flaps back inside the
  confirmation window. Only the last hop — a real APNs/FCM subscription — is
  untested from CI; the browser side needs a granted permission. A tap lands on
  the chat that ended, not just its workspace: the payload carries
  `/w/<workspace>?session=<chat>` (`notify.ts` ▸ `chatRoute`, shared with the
  parked-prompt receipt), the notification is tagged per chat so siblings don't
  replace each other, and `SessionView` keeps the picked chat in that same query
  parameter — one source of truth, so a repeat notification for a chat you tabbed
  away from still wins.

## Run

```bash
yarn install
yarn build          # → dist/
yarn start          # relay serves dist/ + /api  (or `yarn preview` = build+start)
# dev with HMR:  yarn dev   (Vite :5173 proxying /api → relay :8787)
# deploy:  yarn deploy      (build + install a login LaunchAgent; yarn service {status,restart,uninstall})
```

Prints `http://<tailnet-ip>:8787/#token=<token>`. Open on phone → Add to Home
Screen. The write path needs macOS Accessibility permission (applescript) — reads
work without it.

The token is persisted to `~/Library/Application Support/conductor-remote/token`
(`src/config.ts` → `resolveToken`), so it's stable across restarts and the
home-screen URL keeps working. `scripts/service.ts` installs the LaunchAgent
(`no.adluna.conductor-remote`, logs in `~/Library/Logs/conductor-remote/`); it
bakes the absolute `node` path, so re-run `yarn deploy` after an nvm upgrade.

## Open work, in priority order

1. **Validate the sidecar send live.** `WRITE_STRATEGY=sidecar`, send one prompt
   from the phone to a session you're watching, confirm it lands in the right
   agent and the UI reflects it. If clean, make sidecar the default in
   `src/config.ts` (`loadConfig` → `writeStrategy`).
2. **Visual QA on a real phone.** The build + all endpoints are verified, but the
   UI hasn't been screenshotted on-device (browser automation needs an
   interactive Chrome connect this session couldn't do). Check the list, session
   tabs (Chat/Diff), composer, and install/standalone appearance.
3. **SSE push** instead of ~2s polling (optional; polling is fine over a
   LAN/tailnet and simpler).
4. **Session picker.** The API returns all sessions per workspace
   (`/api/workspaces/:id/sessions`); the PWA opens the active one. Add a picker
   for history/side sessions.

## File map

```
src/              Node relay (dev: run as .ts via Node type-stripping; tarball: compiled to dist-node/)
  server.ts       HTTP router: /api/* (token-gated) + static PWA + SPA fallback
  config.ts       paths, port, Tailscale bind, token, write strategy, dist dir
  pkg-root.ts     packageRoot(): walk up to package.json (works from src/ and dist-node/src/)
  db.ts           read-only node:sqlite handle to conductor.db
  reads.ts        workspaces / sessions / messages + worktree resolution
  transcript.ts   Claude Code SDK stream JSON → phone-renderable entries, and back out to
                  markdown (renderTranscript: prose always, thinking/tools per flag). A tool's
                  output travels as its own entry naming the call (`toolUseId`), capped; the
                  markdown render prints the call and leaves the output behind. Reads every
                  result shape — text, edit diffs, tool_reference lists — and numbers a row's
                  images for GET /api/tool-images/:reference (toolImageAt does that lookup)
  attachments.ts  writes a real Conductor attachment from outside Conductor: the file under
                  .context/attachments/<id>/, and the @⟦name⟧(path) token the composer parses
  search.ts       FTS5 index over chat prose in its OWN sidecar db (stateDir()/search.db);
                  backfills in the background, folds chunk hits up into workspaces
  mcp-tools.ts    the 16 MCP tools + a transport-agnostic JSON-RPC dispatcher; tools reach
                  the relay through an injected `call`, so both transports share one path
  mcp.ts          the stdio transport (conductor-remote mcp). HTTP lives in server.ts at
                  POST /mcp, which runs in-process and so is inside the UI lock natively
  git.ts          workspace diff vs target branch (incl. untracked via --no-index)
  merge.ts        merge the workspace's open PR via `gh pr merge` (mirrors Conductor's Merge button)
  sidecar.ts      Conductor sidecar IPC client (JSON-RPC over unix socket)
  writes.ts       Actuator: AppleScript (default) + Sidecar (opt-in); uiTurn() serializes UI ops
  firstprompt.ts  persisted queue that delivers a new workspace's first prompt, from setup on
  parked.ts       persisted queue for prompts that hit the lock screen — delivers on unlock, pushes the receipt
  notify.ts       status-transition watcher + subscription store (~/…/conductor-remote/push.json, 0600)
  webpush.ts      Web Push protocol: VAPID (ES256) + aes128gcm payloads, node:crypto only
  logbuf.ts       console capture (ring + stamped stdout) + log-file tail → GET /api/logs, token redacted
  tailscale.ts    magicdns name, expose posture (funnel|serve), tailscale binary, relay port
  funnel-watchdog.ts  end-to-end probe of the PUBLIC ingress; re-registers a stale funnel, and
                  can move the Mac to a fallback network when it has no route at all
  settings.ts     relay preferences the phone edits (fallback SSIDs, autoRejoin) → stateDir()/settings.json
  wifi.ts         networksetup reads + the one narrow write (join a network macOS already knows).
                  All async: it is slowest exactly when the link is wedged, and the relay is one thread
  nosleep-helper.ts  the root half in one place: the shared POSIX-sh body, the helper file it is
                  installed as, the sudoers drop-in, and helperReady() (runs the real path under sudo -n -k)
  nosleep.ts      arming lid-closed wakefulness from the phone: detached spawn, pidfile discovery
                  across relay restarts, liveness read through EPERM — and the `pmset sleepnow`
                  that ends a window for real (a shut lid never replays its close event)
web/              React PWA (Vite root)
  index.html      loads /self-heal.js synchronously (before the module bundle) so it can catch a dead shell
  src/main.tsx    root: QueryClient + Router (SW registered in ReloadPrompt, not here)
  src/app.tsx     routes (/ list, /w/:id session) + token gate; mounts ReloadPrompt above the gate
  src/hooks.ts    useWorkspaces / useDiff / useTranscript (incremental poll) / useModels (model list, SWR)
                  useSendPrompt (applies the staged agent settings, then sends)
  src/lib/        api client, types, format helpers, cn, composer drafts, staged agent settings,
                  model-list cache, read marks (unread the phone has seen), push (permission/subscribe/reconcile),
                  transcript-merge (folds each tool result onto the call it answers, identity intact)
  src/components/ Patch.tsx renders a unified diff (workspace diff + an edit step's result)
  src/store.ts    zustand: token + connection status + drafts + staged agent settings + read marks
                  + this device's push subscription
  src/components/ Header, WorkspaceList, SessionView, Transcript, DiffView, Composer (AgentBar renders
                  inside its card), StatusPicker, NewWorkspaceSheet, LogsSheet, ReloadPrompt, ui
                  (ConnectSheet carries the Notifications switch + "send a test", and the Mac section:
                  keep-awake windows + the fallback-network picker)
public/           icon.svg source + PWA PNGs (repo-root so Conductor's icon lookup finds them; `yarn gen:icons`)
  self-heal.js    HTML-level stale-client watchdog (see PWA-update note below)
  push-sw.js      push / notificationclick handlers, pulled into the generated SW by workbox.importScripts
scripts/         dev.ts + gen-icons.ts + service.ts (macOS LaunchAgent install/uninstall/status)
                 + qr.ts (dep-free QR of the phone URL, printed by service.ts)
                 + nosleep.ts (the `nosleep [duration|setup|status]` entrypoint)
                 + nosleep-setup.ts (installs the root helper + the scoped sudoers rule)
                 + check-{applescript,imports}.ts (repository source/toolchain validators)
tests/           Vitest unit, contract, concurrency, filesystem and shell integration tests
dist/             built PWA (gitignored) — what the relay serves
dist-node/        compiled relay (gitignored) — src/ + service.ts/qr.ts → JS for the npm tarball
```

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
{working, idle}; `session_messages.content` is Claude Code SDK stream JSON for
assistant/system rows and plain text for user prompts; `queue_order` set +
`sent_at` null = queued-unsent; worktrees at
`<workspacesRoot>/<repo.name>/<directory_name>`.

## Gotchas

- **No Node flags; two run paths.** The relay runs under plain `node` — no
  `--experimental-transform-types`. Dev imports the `.ts` sources directly (Node's
  default type-stripping); an installed package runs the compiled `dist-node/` JS
  because Node refuses to strip `.ts` under `node_modules`. `bin/cli.js` picks by
  whether its own path contains `/node_modules/`. Strip-only mode rejects
  parameter-property constructors/enums/namespaces, so the dev-run sources stay free
  of them (see the strip-clean trap in CLAUDE.md). `bin/cli.js` silences only the
  `node:sqlite` ExperimentalWarning in-process (no re-exec).
- **Yarn standalone.** An empty `yarn.lock` marks this repo as its own project
  (there's a `package.json` higher up in `$HOME`). `.yarnrc.yml` sets
  `nodeLinker: node-modules`.
- **`yarn verify`** = typecheck + lint (Biome) + Vitest + the repository checks.
  `yarn test` runs 17 discoverable test files; `yarn test:watch` focuses the feedback
  loop and `yarn test:coverage` emits V8 text + HTML coverage. AppleScript and the
  relay/web import boundary stay in `check:repo` because they validate source and
  toolchain invariants rather than one runtime unit. The AppleScript compile half is
  macOS-only and skips on Ubuntu; its handler-resolution half runs everywhere.
- **Commit author** is the GitHub noreply address (privacy) — keep it for public
  commits.
- **Releases key off reachable version tags — never rewind `main` after a tagged
  release.** CI's `release` job runs `semantic-release` on every `main` push: it
  takes the highest `vX.Y.Z` tag *reachable from `main`* as the last release and
  bumps from there. Drop an already-released commit from `main` (force-reset /
  rewind) and its tag goes unreachable — semantic-release recomputes the *same*
  next version and dies on `git tag vX.Y.Z already exists`, wedging every later
  release. npm publishes are immutable, so that number is **burned**. Recovery:
  move the colliding tag onto a commit that *is* on `main` — co-locate it with the
  current release tag as a skip-marker — so the next run advances past it
  (`git push origin --force <main-sha>:refs/tags/vX.Y.Z`), then `npm deprecate` the
  burned version. (This is exactly how the stray `v1.17.0` from a reverted
  merge-button take was cleared; next release is `1.18.0`.)
- **PWA self-update (the relay updates fine; the phone can get stuck).** The relay
  auto-updates (`src/autoupdate.ts`) and serves a fresh `dist/`, but an installed
  iOS home-screen PWA rarely re-fetches `sw.js` on its own, so it can keep running a
  stale precached shell while `/api/state` still reports the new relay version — the
  version *label* comes over the network, the *code* from the SW precache, so they
  disagree. Three-layer defence, all in `web/src/components/ReloadPrompt.tsx` +
  `public/self-heal.js`: (1) `registerType: 'prompt'` (NOT `autoUpdate`, which reloads
  mid-compose) + a 60 s `registration.update()` poll to discover a waiting worker;
  (2) a **version gate** — the app bakes its build version in as `__APP_VERSION__`
  (`vite.config.ts` `define`, read from the same `package.json` the relay reports), and
  when `/api/state`'s `version` is ahead it forces an immediate `update()` (recovery in
  one state-poll, not 60 s) and the Connect sheet shows `relay vX · app vY · update
  pending`; (3) `self-heal.js` runs before the bundle and, if a removed hashed asset
  fails to load (the relay's SPA fallback answers `/assets/*` with `index.html` as
  `text/html` → MIME mismatch), unregisters the SW, clears caches, and hard-reloads with
  a `_v=` cache-bust. A client too stale to have *any* of this still needs one manual
  kick (re-add to home screen); after that it self-heals. No `scripts/fix-sw.ts` dance
  (that's macromaxxing's react-router workaround) — plain Vite already gives `index.html`
  a content-hash precache revision, so no-op builds don't re-fire the banner.
```
