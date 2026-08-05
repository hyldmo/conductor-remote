# conductor-remote

Phone control panel for **local** Conductor agents: a dependency-free Node relay
serves an installable React PWA, reads agent state, and relays prompts back into
Conductor. Deep dives live in [HANDOVER.md](./HANDOVER.md) (status, file map) and
[FINDINGS.md](./FINDINGS.md) (the Conductor reverse-engineering the design rests on).

## The load-bearing mental model

Two asymmetric halves — keep them separate:

- **Reads are uncoupled and durable.** All state comes from Conductor's local
  SQLite DB (`conductor.db`, opened **read-only** on a second connection) plus
  `git` in each worktree. No Conductor process is involved, no injection. An app
  update can rename every UI string and reads keep working. Never add a write to
  the DB handle in `db.ts`.
- **Creating a workspace is the one write that isn't fragile.** Conductor's
  documented deep links (conductor.build/docs/reference/deep-links) are
  `conductor://prompt=<enc>[&path=<repo root>]`, `…linear_id=…` and
  `…async?repo=&plan=<base64>` — **all four create a *new* workspace**, none
  focuses an existing one, so they can't replace the navigation above. But
  `createWorkspace` (`POST /api/workspaces`) uses one to start work from the
  phone with no Accessibility and no keystrokes at all. Two traps: parameters sit
  *flat* after the scheme (not behind `?`) and must be URL-encoded (which is also
  what stops a prompt containing `&path=` from moving the workspace), and **an
  unmatched or absent `path` silently falls back to the first repo** — so the
  relay resolves a real `repos.root_path` and 404s an unknown name. **`prompt` is
  optional** — a bare `conductor://path=…` opens an empty workspace like
  Conductor's own New workspace; that form is *undocumented* (every documented
  route carries a prompt) but verified live, so suspect it first if creation
  breaks. The link is fire-and-forget and only *pre-fills* the composer, so the
  relay watches the DB for the new row and the PWA parks any prompt
  (`web/src/lib/firstPrompt.ts`) until the worktree is `ready`, guarded on
  `last_user_message_at` so it can't double-send. Don't block the request on
  setup: it measured 30s+, past the phone's own 25s budget. **Delivery belongs to
  the app shell** (`hooks.ts` ▸ `useFirstPromptDelivery`), never to the session
  view: setup outlasts the user's attention, and an iOS relaunch reopens at `/`,
  so a route-scoped watcher waits for a mount that never comes and the prompt
  rots in localStorage. That same `last_user_message_at` guard is what makes
  retrying safe; after three failed sends the text is stashed into the
  workspace's composer draft (store-backed — `web/src/lib/draft.ts`) so an
  undeliverable prompt sits in the chat box instead of vanishing, and a send
  matching the draft clears it so it can't go twice.
- **Writes are the one fragile nerve.** Prompts go back via the `Actuator`
  interface (`src/writes.ts`), two strategies:
  - `applescript` (**default**): drives Conductor's real UI send. **Conductor's
    webview exposes its whole tree to macOS Accessibility** (the old "Tauri shows
    no AX text" belief was wrong), so nearly nothing is keystrokes — every
    targeting decision is a read of the live UI, and each one fails closed:
    0. **A window must exist first.** Every AX read is rooted at `window 1`, but
       Conductor keeps *running with all its windows closed* (the red button
       doesn't quit), it may not be running at all, and a cold launch draws one
       late — all surfaced as "Can't get window 1 … Invalid index." from
       whichever handler ran first. So `activateConductor` checks permissions,
       then `activate`s (which **starts Conductor if it isn't running**), then
       waits for a real window — ~4s if the app was already up, ~9s for a cold
       launch — nudging with **`reopen`** (the dock-click event — `activate`
       alone won't recreate a closed window), and every `window 1` read stays
       behind `requireWindow`/`webArea` so a window closing mid-run says so in
       words. **"returned 0 windows" and "refused to answer" are different
       facts**, and a boolean loses one: `windowProbe` returns
       `{count, errNum, errText}` (count `-1` = refused) and everything else —
       `hasWindow`, `windowFailure`, the fail-fast in `activateConductor` —
       reads *that*, so a permission refusal can't reach the phone as "no open
       window". The grants are matched on macOS's own error (`assistive access`
       → Accessibility, which **a node upgrade silently revokes**; `-1743` →
       Automation), never on `UI elements enabled` — that flag **can report
       true for a process that isn't itself trusted**, which is why it was
       dropped. An unrecognised refusal is reported verbatim with its number
       rather than mapped to the nearest known cause. If `reopen` has drawn
       nothing by ~3s the app isn't answering that event, so `dockClick`
       clicks the real Dock tile — delivered by the Dock through Conductor's own
       event loop, not as an Apple event we send. **There is no "New Window" to
       press**: Conductor is single-window and single-instance, so once reopen
       and the Dock click have both drawn nothing, restarting the app is the
       only lever left. That branch reports `windowEvidence()` — every process
       matching `Conductor` with its window count, plus the menu bar titles —
       because *which* process owns the on-screen window is the one fact that
       separates "genuinely windowless" from "we're addressing the wrong
       process". Then `restartConductor` quits and relaunches — **the only
       remaining lever**, and the one step here that can destroy work, so it is
       gated on `RELAY_ALLOW_RESTART`, which `server.ts` sets from a live DB
       read (`no workspace is 'working'`) — writes.ts must never decide this
       itself. It is **fire-and-forget**: a cold launch doesn't fit the phone's
       budget alongside the send, so it returns as soon as the relaunch starts
       and tells the phone to send again. "Open it on your Mac" is not advice a
       phone can act on.
    1. **Workspace** — press its sidebar row (an `AXLink` named
       "&lt;repo&gt; &lt;title&gt; +adds -dels"). No keystrokes at all, so nothing can be
       swallowed by a focused field. Only *rendered* rows exist in the AX tree, so
       a **collapsed sidebar section is invisible** — and the row title follows
       Conductor's precedence (manual name → PR title → humanized branch →
       codename), so `writes.ts` tries each candidate and requires a *unique* hit.
       Anything missing or ambiguous falls back to the command palette
       (Cmd+K → **branch name** → Enter); the branch is the palette's unique
       per-workspace key, and a looser query can match a *command* (e.g. unarchive).
    2. **Assert we landed there** — the pane header carries the branch as
       `AXStaticText` (owner prefix stripped) and the repo as an `AXPopUpButton`.
       Mismatch → abort. This is what catches a palette hit on the wrong thing.
    3. **Chat tab** — the strip is an `AXTabGroup` whose `AXRadioButton`s are the
       tabs (`AXValue` = selected, `AXPress` = switch, it does *not* close the
       chat), ordered like `reads.listSessions` (created_at ASC). Addressed by
       index, label cross-checked, re-read to confirm. Without this every prompt
       lands in whichever tab was already active. **The terminal panel is an
       `AXTabGroup` too** (Setup/Run/Terminal 1) — candidates are scored on tab
       count + label and a tie aborts, so we never type into a terminal.
    4. **Composer** — `AXGroup "composer"` holds an `AXTextArea` whose `AXFocused`
       and `AXValue` are both settable, so the prompt is *written*, read back to
       verify, then Enter. No clipboard hijack, no Cmd+L/Cmd+V. Clipboard paste
       survives only as a fallback — and `fillComposer` **clears whatever it wrote
       before falling back**, or the paste appends and sends a garbled prompt.

    Landing in the wrong agent is worse than not sending, so every step errors out
    rather than guessing. No private protocol, nothing to rebreak on a Conductor
    update. The remaining keystroke delays (palette fallback) are load-bearing.

    The same verified path drives the chat's **agent settings** (`setAgentOptions`,
    `POST /api/sessions/:id/agent`). Their *values* are plain reads — `sessions`
    has `model`, `claude_effort_level`, `fast_mode`, `permission_mode` — so only
    the writes touch the UI: effort is a button whose **label is its own value**
    and which *cycles* (Low → Medium → High → Extra high → Max → Ultracode → wrap),
    so we press until the label matches; Plan is an `AXCheckBox` with readable
    state; the model picker is an `AXMenu` (labels carry badges — "Opus 5 NEW" —
    so matching prefers exact then unique-prefix, and `GET …/models` enumerates it
    live rather than hard-coding a list that would rot). **Fast has no readable
    state and only exists for some models**, so the DB decides whether to press it
    and a missing button is reported, not ignored. Every change is confirmed
    against the DB before the API returns success.
  - `sidecar` (opt-in, `WRITE_STRATEGY=sidecar`): JSON-RPC over Conductor's unix
    socket, addresses a session by id. Precise in principle but speaks a private
    `-v2-` protocol — the most update-fragile surface here, and **currently
    non-functional against Conductor 0.76**: the `query` schema drifted and idle
    sessions aren't live in the sidecar (they need a session-resume handshake), so
    the shipped payload fails loud (`ok:false`). Don't half-fix the schema — a
    `type:"query"` payload *validates then silently drops* the prompt. **A live
    `query` send injects a real prompt into a running agent; never auto-run it to
    "test."** Since `applescript` is now precise, sidecar buys nothing today.

`sessions.id == claude_session_id` — Conductor is a GUI over Claude Code sessions.

## Commands

```bash
yarn verify   # typecheck (tsc) + lint (Biome) — run before every commit
yarn fix      # Biome autofix (format + safe lints)
yarn build    # Vite → dist/ (the PWA the relay serves)
yarn build:node # tsc -p tsconfig.build.json → dist-node/ (compiled relay for the npm tarball)
yarn start    # run the relay (node bin/cli.js)
yarn dev      # Vite :5173 (HMR) proxying /api → relay :8787
yarn deploy   # build + install/reload the login LaunchAgent, print phone URL
yarn service  # {status,restart,uninstall} the LaunchAgent
```

There are no automated tests; `yarn verify` (typecheck + lint) is the gate.
Verify a runtime change by curling the relay (see the bind trap below), not by
unit test.

## Traps (these will bite)

- **Two run paths, one source: dev strips `.ts` live, the tarball ships compiled JS.**
  In a dev checkout `bin/cli.js` imports the `src/*.ts`/`scripts/*.ts` sources directly
  under plain `node` (Node 24's default TS *type-stripping*, no `--experimental-transform-types`).
  But Node **refuses to type-strip anything under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
  so an *installed* package can't run raw `.ts` — it must ship real JS. So `prepack`
  runs `yarn build:node` (`tsc -p tsconfig.build.json`) → `dist-node/`, and `bin/cli.js`
  picks the artifact by whether its own path contains `/node_modules/` (compiled) or not
  (live source). `tsconfig.build.json` uses **`rewriteRelativeImportExtensions`** so the
  sources keep their `.ts` import specifiers (which let Node run them unbuilt) and emit
  gets them rewritten to `.js` — never "fix" the `.ts` imports, they're load-bearing for
  the dev path. The tarball still has **zero runtime deps** (relay is stdlib-only; `dist-node`
  is plain JS + `node:*`), and `files` ships `bin`/`dist`/`dist-node` only — **no raw `.ts`**.
  - The dev path is still strip-only, so keep the code free of syntax that must be
    *transformed* — **parameter-property constructors, enums, namespaces**. `db.ts`/`reads.ts`
    use explicit field assignments for exactly this reason (they once used `constructor(private readonly …)`).
    (`tsc` in the node build *could* transform those, but the dev run can't, so the ban stands.)
  - Anything that resolves a path against the package root must anchor on `packageRoot()`
    (`src/pkg-root.ts`), **not** `import.meta.dirname/..` — the compiled files sit one dir
    deeper (`dist-node/src/…`), so a hard `..` points at `dist-node`, not the real root.
  - The one experimental bit left, `node:sqlite`, only warns — `bin/cli.js` silences
    just that warning (no re-exec).
- **The relay binds loopback; the HTTPS URL comes from Tailscale, and `EXPOSE` picks
  who can reach it.** `server.listen` uses `127.0.0.1` (override with `RELAY_HOST`), and
  `yarn deploy` (`service.ts` → `ensureTailscale`) fronts a stable `https://<magicdns>/`
  with real TLS (which the PWA service worker needs). Two modes, `EXPOSE=public|tailnet`:
  `public` (**default**) = `tailscale funnel` — reachable from **any browser on the
  internet**, gated only by the 128-bit token (`server.ts` compares it constant-time);
  `tailnet` = `tailscale serve` — tailnet devices only. The chosen mode is persisted
  next to the token (`…/conductor-remote/expose`) so a bare re-deploy keeps posture;
  switching to `tailnet` runs `funnel reset` first. Funnel must be enabled for the
  tailnet (Admin console nodeAttr) or it falls back to tailnet-only and says so.
  `curl 127.0.0.1:8787` works for local checks; `yarn service status` prints the URL
  and whether it's public or tailnet-only.
- **Token is persisted**, not per-boot: `~/Library/Application Support/conductor-remote/token`
  (`config.ts` → `resolveToken`). Don't reintroduce a random-per-start token — it
  breaks the phone's saved home-screen URL. `RELAY_TOKEN` env still overrides.
- **A workspace's own branch is not the one in the session snapshot, and its
  "sibling" directory may be itself.** Conductor creates the worktree under a
  *codename* (`directory_name`, e.g. `…/conductor-remote/ouagadougou`) and renames
  the branch once the workspace is named, then drops a **symlink beside it named
  after the new branch** (`collapse-thinking-steps-group → ouagadougou`). So the
  agent harness's start-of-session `git status` can name a branch
  (`hyldmo/<codename>`) that no longer exists, `GET /api/state` reports the *live*
  branch, and the two look like two different workspaces sharing a repo. Read the
  branch with `git branch --show-current` before acting on it, and resolve a path
  with `readlink -f` before concluding another workspace is doing your work.
- **Yarn is standalone here.** Its own `yarn.lock` + `.yarnrc.yml`
  (`nodeLinker: node-modules`) makes this its own project despite a `package.json`
  higher up in `$HOME`. `package.json` pins `yarn@4` via `packageManager`, so
  contexts without a corepack shim (CI, a bare shell) must `corepack enable` first
  — see `.github/workflows/ci.yml`. The verify script is named `verify`, not `check`
  (collides with a Yarn Classic builtin).
- **The log is a wire surface now, not just a file.** `installLogCapture()`
  (`src/logbuf.ts`, called first thing in `server.ts`) wraps `console.*`: every line
  also lands in a 600-entry ring served by `GET /api/logs`, and the stdout copy gains a
  `YYYY-MM-DD HH:MM:SS` prefix (plus `WARN`/`ERROR` for those levels) — that prefix is
  what lets `?file=relay.log` parse the *daemon's* on-disk log back into stamped, levelled
  entries, which is the only way to see a crash that happened before the current process.
  Two consequences: **the startup banner prints the token**, so everything served goes
  through `redactSecrets` first (the endpoint is token-gated, but the whole point is
  pasting logs into an issue) — never add a log surface that skips it; and log lines are
  now user-visible text, so don't log anything you wouldn't hand to whoever holds the
  token. The file tabs belong to the LaunchAgent, so the response carries `managed` and
  the UI says so when this relay isn't the process writing them.
- **Editing the AppleScript in `writes.ts`: two silent traps.** (1) Inside a
  `tell application "System Events"` block, ordinary-looking variable names
  resolve as **System Events terms** — `tabs` and `groups` become "every tab/group
  of the process", so a loop over your own list quietly iterates the wrong thing
  and the handler returns nothing. Keep logic *outside* the tell and reach in via
  one-line helpers (`tabLabel`, `paneLabels`), or name variables `strip`/`pane`.
  (2) The script lives in a **TS template literal** — a backtick in an AppleScript
  comment terminates it and `tsc` reports a nonsense error tens of lines away.
  Use quotes in those comments.
- **If a Conductor update breaks a read**, re-derive from the DB schema; if it
  breaks the sidecar write, re-derive from `conductor-runtime`. Both procedures
  are in HANDOVER ▸ "Re-deriving Conductor internals."

## Conventions

- **Biome** formats and lints (`biome.jsonc`): tabs, single quotes, no semicolons,
  no trailing commas, 120 cols, arrow parens as-needed. Don't hand-format — run `yarn fix`.
- **TS strict**, `verbatimModuleSyntax` (use `import type`), `.ts`/`.tsx` extensions
  in imports are required (`allowImportingTsExtensions`).
- **Layout:** `src/` = Node relay (server, db, reads, git, transcript, sidecar,
  writes, config). `web/` = Vite-root React PWA (`web/src/`). `public/` = static
  PWA assets at the **repo root** (not under `web/`) so Conductor's repo-icon lookup
  finds them (`vite.config.ts` sets `publicDir: '../public'`); `scripts/` = dev,
  icon-gen, service installer. `dist/` = build output (gitignored, relay-served).
- **Utility scripts** run under plain `node` (default type-stripping), stdlib-only —
  keep them strip-clean too (no param-property constructors/enums/namespaces).
- **Commit author** is the GitHub noreply address (privacy) — keep it for public commits.
