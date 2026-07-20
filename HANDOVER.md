# Handover — continue here

Snapshot for picking this up cold (last updated 2026-07-19). Read
[README.md](./README.md) for usage and [FINDINGS.md](./FINDINGS.md) for the
reverse-engineering that shaped the design.

## Where it stands

A complete, installable **PWA** (React 19 · Vite 7 · Tailwind v4 ·
`vite-plugin-pwa` · TanStack Query · Zustand · Biome) served by a dependency-free
**Node relay**. Built and verified against a live Conductor on macOS.

- **Reads — done and working.** SQLite (`conductor.db`) + `git` per worktree.
  Verified end-to-end against the live app: 47 workspaces with status/model/
  branch/context %, a 136-message transcript parsed into user/assistant/tool
  entries, diff vs target branch (incl. untracked), token auth (401 without),
  static PWA + SPA deep-link fallback, manifest + service worker + icons.
- **Writes — two strategies behind the `Actuator` interface:**
  - `applescript` (**default**): drives Conductor's real UI send → focused
    session. Safe (reuses the session's own model/permission mode).
  - `sidecar` (**opt-in**, `WRITE_STRATEGY=sidecar`): precise per-session send
    over Conductor's dispatch socket. Socket + local auth + JSON-RPC protocol
    **validated with safe read RPCs**; a real `query` send is implemented but not
    auto-run (it would inject into a live agent). See FINDINGS ▸ Writes.

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
  transcript.ts   Claude Code SDK stream JSON → phone-renderable entries
  git.ts          workspace diff vs target branch (incl. untracked via --no-index)
  sidecar.ts      Conductor sidecar IPC client (JSON-RPC over unix socket)
  writes.ts       Actuator: AppleScript (default) + Sidecar (opt-in)
web/              React PWA (Vite root)
  index.html
  src/main.tsx    root: QueryClient + Router + SW registration
  src/app.tsx     routes (/ list, /w/:id session) + token gate
  src/hooks.ts    useWorkspaces / useDiff / useTranscript (incremental poll)
  src/lib/        api client, types, format helpers, cn
  src/store.ts    zustand: token + connection status
  src/components/ Header, WorkspaceList, SessionView, Transcript, DiffView, Composer, ui
  public/icon.svg source icon (PNGs via `yarn gen:icons`)
scripts/dev.ts + gen-icons.ts + service.ts (macOS LaunchAgent install/uninstall/status) + qr.ts (dep-free QR of the phone URL, printed by service.ts)
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
- **`yarn verify`** = typecheck + lint (Biome). `yarn check` collides with a Yarn
  Classic builtin, so the script is `verify`.
- **Commit author** is the GitHub noreply address (privacy) — keep it for public
  commits.
```
