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
  - **Unread is the one read that needs a second source.** `workspaces.unread` is
    a **dead column** — Conductor still declares it (its migration still says
    "when 1, the workspace should be marked visually as unread") but writes 0 on
    every row (0 of 1691 here), which is why the sidebar's bold/badge never once
    fired. The live flag is per chat, `sessions.unread_count`, and it *is* a flag
    — only ever 0 or 1 — so what the sidebar counts is **unread chats**, not the
    column's value, and one of them draws a dot rather than the meaningless
    number "1". Conductor clears it when you open the workspace **on the Mac**,
    and this relay is read-only, so a chat read on the phone would shout forever:
    the PWA keeps its own marks (`web/src/lib/read.ts`) — the session's own
    `updated_at` at the moment it was on screen, never our clock, because it is
    only ever compared against that same column. The session view marks *only*
    the chat on screen (a sibling tab's badge isn't ours to clear) and only while
    the page is visible.
  - **"How long has this answer been running" is not `last_user_message_at`.**
    That column moves on **every** user message, including one typed *into* a
    running turn — steering — so the chat's elapsed timer would restart mid-answer
    on the one message that didn't start an answer. Conductor already separates the
    two: `session_messages.turn_id` groups a turn (a steering message carries the
    running turn's id), and **`queue_order` is set exactly on the messages that
    head a turn** and NULL on steering ones. So `turn_started_at`
    (`reads.listSessions`) is `MAX(sent_at)` over this session's heads — `sent_at`,
    not `created_at`, because a prompt can sit queued for minutes before it runs,
    and skipping the `sent_at IS NULL` ones is what stops a message queued behind
    the current answer from blipping the timer. `queue_order` only appeared in
    **May 2026** (every row before that is NULL), so a chat dormant since then
    reports null and the phone just shows the dots with no timer. It rides on the
    2s session poll for free — `idx_session_messages_sent_at(session_id, sent_at)`
    serves it directly.
- **Deep links carry the two writes that aren't fragile — creating a workspace
  and focusing one.** The *documented* links
  (conductor.build/docs/reference/deep-links) are
  `conductor://prompt=<enc>[&path=<repo root>]`, `…linear_id=…` and
  `…async?repo=&plan=<base64>`, and **all four create a *new* workspace**. The
  one that focuses an existing one is undocumented but public — it is what
  Conductor's own sidebar row menu copies under **"Copy link"** (Cmd+⇧C):
  **`conductor://workspace?id=<workspace>&session=<chat>`**, both ids exactly the
  ones the relay already reads. `writes.ts` ▸ `workspaceLink` builds it and
  `openViaDeepLink` is now the *first* step of every send, because it is not
  merely faster (~2s against the ~18s the sidebar/palette path measured) — it
  navigates by **id**, so a collapsed sidebar section stops mattering, and it
  opens the chat tab explicitly, so a pane left on a file view or a terminal
  comes back to the composer instead of failing with "couldn't identify the chat
  tab strip". It stays fail-closed: the URL is fire-and-forget, so what counts as
  success is the same pane assertion as before, and the sidebar row and palette
  remain the fallback. **The near misses fail badly, so never hand-write this
  URL**: `workspace` must be the URL's *host* and the parameters sit behind a
  real `?`, because `conductor:///workspace/<id>` (id in the path, empty host)
  falls through to the flat-parameter parser and **creates a new workspace in the
  first repo** — `conductor://workspace/<id>` is merely ignored. The shareable
  `https://app.conductor.build/workspace/<id>?session=<chat>` form reaches the
  same handler, but the desktop build declares no associated domain, so macOS
  gives it to a browser first; locally, use the scheme.
  `createWorkspace` (`POST /api/workspaces`) uses the other link to start work
  from the phone with no Accessibility and no keystrokes at all. Two traps: parameters sit
  *flat* after the scheme (not behind `?`) and must be URL-encoded (which is also
  what stops a prompt containing `&path=` from moving the workspace), and **an
  unmatched or absent `path` silently falls back to the first repo** — so the
  relay resolves a real `repos.root_path` and 404s an unknown name. **`prompt` is
  optional** — a bare `conductor://path=…` opens an empty workspace like
  Conductor's own New workspace; that form is *undocumented* (every documented
  route carries a prompt) but verified live, so suspect it first if creation
  breaks. The link is fire-and-forget and only *pre-fills* the composer — someone
  still has to press Enter ~30s later, once the worktree is `ready` and the chat
  exists. **That someone is the relay** (`src/firstprompt.ts` ▸ `FirstPromptQueue`),
  never the phone: a phone sleeps, iOS suspends a backgrounded PWA outright, and
  the delivery hook it used to run only looked at its parked set once per app
  launch, so prompts sat unsent until the next relaunch. Don't confuse that with
  "block the request": creation still returns as soon as the row exists (~2s;
  waiting for setup measured 30s+, past the phone's own 25s budget) and the queue
  delivers on its own schedule. `send:true` opts an API caller into awaiting it.
  Three properties hold it up: **one owner** (if the phone delivered too,
  `last_user_message_at` wouldn't save you — it's a read, not a lock, and both
  sides can read it null; the guard is still what makes *retrying* safe and what
  detects a prompt sent by hand from the Mac); **persistence** to
  `…/conductor-remote/first-prompts.json`, because `autoupdate` deliberately
  `exit()`s to reload and launchd restarts us mid-setup; and **giving up in
  public** — after 3 sends or 15 minutes the entry flips to `failed` *and stays*,
  riding along on `/api/state` as `workspace.pending_prompt` so the chat can show
  the text with the reason and a Retry (`DELETE …/workspaces/:id/prompt`
  dismisses it). A waiting prompt shows the same way, because 30s of empty pane
  reads as "swallowed" and gets retyped — which is the same prompt sent twice.
- **Only one UI operation at a time** (`writes.ts` ▸ `uiTurn`). Every AppleScript
  here drives Conductor's single shared window, so two overlapping runs interleave
  and land a prompt in whatever the other one focused — the exact failure every
  step's fail-closed assertion *cannot* catch, since each script's reads are true
  when it makes them. It was unreachable while every write was one person tapping
  one button; the first-prompt queue, which sends on its own schedule, is what made
  it reachable.
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
       waits for a real window — ~4s if one is already up, ~9s when the probe
       shows none, cold launch or not: the restart lever below is
       fire-and-forget, so the next attempt can arrive while Conductor is still
       drawing its first window, and a short wait there would quit it again
       mid-launch, turning one restart into a loop that never lets it come up —
       nudging with **`reopen`** (the dock-click event — `activate`
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
    1. **Workspace** — open its own Conductor link (`openViaDeepLink`, see the
       deep-link bullet above): one URL carrying the workspace id and the chat id,
       and the whole ladder below exists only for a Conductor that doesn't answer
       it. Falling down that ladder: ask whether we're *already there*
       (`atTargetWorkspace`) — the pane header answers in ~0.5s where finding the
       row to press costs ~10s — then press its sidebar row (an `AXLink` named
       "&lt;repo&gt; &lt;title&gt; +adds -dels"). No keystrokes at all, so nothing
       can be swallowed by a focused field. Only *rendered* rows exist in the AX
       tree, so a **collapsed sidebar section is invisible** — and the row title
       follows Conductor's precedence (manual name → PR title → humanized branch →
       codename), so `writes.ts` tries each candidate and requires a *unique* hit.
       Anything missing or ambiguous falls back to the command palette
       (Cmd+K → **branch name** → Enter); the branch is the palette's unique
       per-workspace key, and a looser query can match a *command* (e.g. unarchive).
    2. **Assert we landed there** — the pane header carries the branch as
       `AXStaticText` (owner prefix stripped) and the repo as an `AXPopUpButton`.
       Mismatch → abort. This is what catches a palette hit on the wrong thing.
    3. **Chat tab** — the link in step 1 already selected it, so this is mostly a
       confirmation now; it still presses when it has to, and it is the only check
       that a `session=` Conductor declined (a hidden chat has no tab) doesn't pass
       silently. The strip is an `AXTabGroup` whose `AXRadioButton`s are the tabs
       (`AXValue` = selected, `AXPress` = switch, it does *not* close the chat),
       ordered like `reads.listSessions` (created_at ASC). Addressed by index,
       label cross-checked, re-read to confirm. **The tabs are not the strip's
       direct children** — each sits one `AXGroup` deep, named for its own close
       action ("Close chat &lt;title&gt;"), and beside them as a *direct* child is
       a "Close file view" radio button that is not a chat at all. Reading only the
       direct children (`stripRadios` now reads both levels, `chatTabs` keeps the
       "Close chat" ones) made every strip look like a one-tab strip called "Close
       file view", which then lost the scoring below to the terminal panel and
       failed every send with "chat tab 1 not found". **The terminal panel is an
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

    **A failed send retries itself** (`deliverPrompt` in `server.ts`) — the phone
    should not be handed a Retry button for what is nearly always a warm-up cost.
    What makes that safe rather than a way to send twice is that **the transcript is
    the receipt**: every run, *including* one that reported an error, is followed by
    a `CONFIRM_WINDOW_MS` watch for the matching user row, so an attempt that landed
    late — or was killed just after pressing Enter — is reported as delivered
    instead of repeated. (`fillComposer` *setting* AXValue rather than appending is
    the other half: a retry replaces a half-written prompt.) Two limits keep it
    honest: refusals a retry can't fix (`retryWontHelp` — a revoked Accessibility
    grant) stop on the spot rather than burning a budget to say the same thing, and
    **the relay never outlasts its caller**. The phone states its deadline in
    `x-client-timeout-ms` and the relay retries inside it; don't re-pair those two
    numbers by hand, because the relay self-updates while the PWA sits in a
    service-worker cache, and a phone that gives up first shows a failure for a
    prompt that then lands. A caller that sends no header gets the budget that fits
    the *old* PWA's flat 25s abort. Because `uiTurn` can hold a run behind another
    write, each run's ceiling comes off that deadline **when it actually starts**
    (`runCeiling`), never when it was queued. The queue's own 3-sends-over-15-minutes
    schedule sits outside all of this: it retries a delivery that never got off the
    ground, not one Conductor fumbled.

    Budgets here are measured, not chosen: a send that *worked* took 23.6s against a
    30-workspace sidebar, which is why the 20s per-run ceiling was killing ordinary
    sends. Re-measure rather than re-guess (`SEND_ATTEMPT_MS`).

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

    **The phone doesn't push these on tap — the send does.** A tap only *stages*
    the change (`web/src/lib/agentDraft.ts`, keyed by session id and persisted
    exactly like the composer draft it belongs to), and `useSendPrompt` POSTs the
    patch *before* the prompt and drops the prompt if it didn't stick — running it
    on the model the user just moved away from is the same class of mistake as
    landing it in the wrong workspace. That's why staged pills are coloured, why
    staging still works with the relay down, and why flipping a value back to
    Conductor's own clears the staged one instead of queuing a no-op round trip
    (`clearAgentDraft` clears key by key, so a change made *during* a send stages
    for the next one instead of being swallowed). `GET …/models` is then the only
    tap-time trip left, and it's the expensive one — it activates Conductor and
    opens the real menu — so its result is cached per `agent_type` and served
    stale-while-revalidate (`web/src/lib/models.ts` ▸ `useModels`): the picker
    paints from the last list and refreshes behind it, and a refresh that fails
    keeps that list on screen and says so rather than emptying it.

    **Workspace status** (`setWorkspaceStatus`, `POST /api/workspaces/:id/status`)
    is the one write that touches no pane at all — it right-clicks the workspace's
    *sidebar row* (`AXShowMenu`), so what's on screen never changes. Conductor
    offers this nowhere else: **the menu bar has no status command and the palette
    has none either**, so the row menu (Mark as unread · Pin · Set status · Rename
    · Copy link · Archive) is the only lever, and a collapsed sidebar section —
    which hides the row from Accessibility entirely — is reported rather than
    worked around, because there is no fallback to fall back to. Three things bite:
    the row must be **scrolled into view** (`AXScrollToVisible`) or `AXShowMenu`
    succeeds and draws nothing, which is exactly what happens right after a status
    change moves the row to a different group; the submenu opens **nested inside
    the same `AXMenu`** (titled `Set status`) rather than as a sibling, so the
    `setModel` trick of scanning the web area's direct children misses it; and the
    outer menu handle goes **stale** across that expansion, so it is re-found each
    poll. Depth caps on those sweeps are load-bearing — the transcript hangs off
    the same root, so an unbounded search costs more than the entire write and gets
    worse the longer the chat is. Why it exists: Conductor derives status from a PR
    it sometimes never links (one that opens and merges inside its poll window is
    invisible to it afterwards), stranding finished work in "In progress" with no
    phone-side fix. Labels come from Conductor's own menu — the `canceled` spelling
    is the one taken from the UI rather than confirmed against stored data. One
    caveat when testing: `uiTurn` serializes *our* UI operations, not the human's,
    and an open menu dies the moment someone clicks elsewhere — so a run that fails
    while you are using the Mac is contention, not a bug. Uncontended it is 6/6 at
    ~11s; typing in Conductor at the same time made it look flaky.
  - `sidecar` (opt-in, `WRITE_STRATEGY=sidecar`): JSON-RPC over Conductor's unix
    socket, addresses a session by id. Precise in principle but speaks a private
    `-v2-` protocol — the most update-fragile surface here, and **currently
    non-functional against Conductor 0.76**: the `query` schema drifted and idle
    sessions aren't live in the sidecar (they need a session-resume handshake), so
    the shipped payload fails loud (`ok:false`). Don't half-fix the schema — a
    `type:"query"` payload *validates then silently drops* the prompt. **A live
    `query` send injects a real prompt into a running agent; never auto-run it to
    "test."** Since `applescript` is now precise, sidecar buys nothing today.

- **Notifications are a read that pushes** — the cheap third shape, on the durable
  side of the split. `src/notify.ts` polls the same read-only SQLite for
  `sessions.status` transitions and POSTs a Web Push message; no Conductor
  process, no AX, no window. **`working → idle` is the whole trigger** — it is
  what "done", "asked you a question" and "waiting on a permission prompt" all
  look like, because each ends the turn — plus `→ error`. Don't hunt for a
  finer-grained signal: the schema has no permission-request table (checked), and
  `status` only ever holds `working`/`idle`/`error`. Two invariants keep it from
  being a nuisance: a transition must **survive one more tick** before it fires
  (a queued prompt restarting the turn would otherwise buzz for nothing), and the
  first tick after a device subscribes is a **baseline, not a broadcast** (else
  enabling it fires once per already-idle workspace). Web Push is written out of
  `node:crypto` in `src/webpush.ts` (VAPID ES256 + `aes128gcm`) to keep the
  tarball's **zero runtime deps** — the traps there are that ES256 needs raw
  `r||s` (`dsaEncoding: 'ieee-p1363'`, not Node's default DER) and that **the
  VAPID keypair must never be regenerated behind a live subscription**, since
  `applicationServerKey` is baked in at subscribe time and a re-keyed relay is
  rejected forever after — hence the persisted `push.json` and the client-side
  `matchesKey` re-subscribe. The phone re-POSTs its subscription on **every app
  load** from the shell (`hooks.ts` ▸ `usePushSync`, not the Connect sheet):
  a subscription the relay has lost still looks enabled from the phone, so
  repairing it can't wait for someone to open a sheet and look. The push handlers
  live in `public/push-sw.js` (plain JS, pulled into the Workbox-generated worker
  via `workbox.importScripts`) and **must always show a notification** — iOS drops
  the subscription for a silent push.

`sessions.id == claude_session_id` — Conductor is a GUI over Claude Code sessions.

## Commands

```bash
yarn verify   # typecheck (tsc) + lint (Biome) + AppleScript check — run before every commit
yarn fix      # Biome autofix (format + safe lints)
yarn check:applescript # osacompile src/*.applescript + resolve every `my handler()` call
yarn build    # Vite → dist/ (the PWA the relay serves)
yarn build:node # tsc -p tsconfig.build.json → dist-node/, then copy src/*.applescript beside it
yarn start    # run the relay (node bin/cli.js)
yarn dev      # Vite :5173 (HMR) proxying /api → relay :8787
yarn deploy   # build + install/reload the login LaunchAgent, print phone URL
yarn service  # {status,restart,uninstall} the LaunchAgent
```

The only automated test is `scripts/check-applescript.ts`, which `yarn verify`
runs: `osacompile` parses `src/conductor.applescript` the way `osascript` will,
and every `my handler()` call — in the script *and* in the TypeScript that
appends to it — must resolve to an `on handler(`. AppleScript binds handler calls
at run time, so those are two different failures and osacompile only sees one.
The compile half is macOS-only and skips on CI (ubuntu); the resolution half runs
everywhere, which is what catches a rename in a pull request.
Nothing else is tested. Verify a runtime change by curling the relay (see the
bind trap below), not by unit test.

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
    A *sibling* asset is the exception and the only one: `writes.ts` joins
    `import.meta.dirname` to reach `conductor.applescript`, which works at both depths
    precisely because the file moves with it. **`tsc` emits only `.js`**, so anything
    non-JS that `src/` ships needs its own copy line in `build:node` — miss it and the
    tarball is fine at typecheck, fine at lint, and dead on first import.
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
- **Editing `src/conductor.applescript`.** Inside a `tell application "System
  Events"` block, ordinary-looking variable names resolve as **System Events
  terms** — `tabs` and `groups` become "every tab/group of the process", so a loop
  over your own list quietly iterates the wrong thing and the handler returns
  nothing. Keep logic *outside* the tell and reach in via one-line helpers
  (`tabLabel`, `paneLabels`), or name variables `strip`/`pane`. Nothing else in
  the toolchain reads this language, so run `yarn verify` after every edit.
  - **It is a real file, and that is load-bearing in two directions.** `writes.ts`
    reads it as a sibling of its own module (`import.meta.dirname`, the one place
    that may — see the `packageRoot()` rule below), so `yarn build:node` has to
    copy it next to the emitted JS; `tsc` only emits `.js`, and without that `cp`
    the published tarball boots to an ENOENT. It also used to live in a **TS
    template literal**, where a backtick in a comment terminated the string and
    `tsc` blamed a line tens of lines away — that trap is gone, and moving it back
    would bring it back.
- **The installed PWA's viewport is not the box iOS lays it out in, and `dvh`
  reports whichever one it currently believes.** Measured in the iOS 26.5
  Simulator (iPhone 17 Pro, 874pt screen, home-screen web app): `innerHeight`,
  `100dvh`, `100vh` and `100lvh` all read 874 — but `documentElement.clientHeight`
  is **812**, the screen minus the top inset. So a `100dvh` app column overflows
  its own root by 62px and the *page* becomes draggable; dragging it slides the
  app off the top and opens a dead band at the bottom, which is what "I have to
  scroll up and down before it's full-screen" actually is. The catch is that the
  two numbers are coupled: stop the overflow (`position:fixed`, or `height:100%`)
  and WebKit re-lays-out in the safe box, `innerHeight`/`dvh` *become* 812, and the
  dead band is now permanent. `100vh` was the only unit that stayed 874 in both
  states, so `index.css` locks `html,body{overflow:hidden}` and sizes the
  standalone app off `vh` (browsers keep `dvh` — there `vh` is the *large*
  viewport and would bury the composer under Safari's toolbar). Corollary: **every
  scroller must stay an inner element**; the document must never be one.
- **Verify PWA layout in the iOS Simulator, not by reasoning.** None of this
  reproduces in desktop Chrome or even simulator *Safari* (there `clientHeight ==
  innerHeight` and the insets are 0) — only in a real home-screen web app. Recipe:
  `xcrun simctl boot "iPhone 17 Pro"`, serve the build (`RELAY_PORT=879x yarn
  start`), `simctl openurl` the token URL, then drive Safari's Share ▸ Add to Home
  Screen with `cliclick` (map device points to screen with `x+760, y+124` for the
  default window position; **one click per shell call** — batched clicks get eaten
  by sheet animations), and read state back with `simctl io booted screenshot`.
  Tapping the installed icon *resumes*; to load new HTML, re-add the icon.
- **If a Conductor update breaks a read**, re-derive from the DB schema; if it
  breaks the sidecar write, re-derive from `conductor-runtime`. Both procedures
  are in HANDOVER ▸ "Re-deriving Conductor internals."

## Conventions

- **Biome** formats and lints (`biome.jsonc`): tabs, single quotes, no semicolons,
  no trailing commas, 120 cols, arrow parens as-needed. Don't hand-format — run `yarn fix`.
- **TS strict**, `verbatimModuleSyntax` (use `import type`), `.ts`/`.tsx` extensions
  in imports are required (`allowImportingTsExtensions`).
- **Layout:** `src/` = Node relay (server, db, reads, git, transcript, sidecar,
  writes, config) plus `conductor.applescript`, the UI script `writes.ts` runs.
  `web/` = Vite-root React PWA (`web/src/`). `public/` = static
  PWA assets at the **repo root** (not under `web/`) so Conductor's repo-icon lookup
  finds them (`vite.config.ts` sets `publicDir: '../public'`); `scripts/` = dev,
  icon-gen, service installer, AppleScript check. `dist/` = build output
  (gitignored, relay-served).
- **Utility scripts** run under plain `node` (default type-stripping), stdlib-only —
  keep them strip-clean too (no param-property constructors/enums/namespaces).
- **Commit author** is the GitHub noreply address (privacy) — keep it for public commits.
