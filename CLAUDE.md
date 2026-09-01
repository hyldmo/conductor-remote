# conductor-remote

Phone control panel for **local** Conductor agents: a dependency-free Node relay
serves an installable React PWA, reads agent state, and relays prompts back into
Conductor. Deep dives live in [ARCHITECTURE.md](./ARCHITECTURE.md) (file map, and how
to re-derive Conductor's internals) and [FINDINGS.md](./FINDINGS.md) (the Conductor
reverse-engineering the design rests on).

> [!IMPORTANT]
> This repository supports **local Conductor workspaces on macOS only**. Do not add
> compatibility branches, setup paths, or fallbacks for Conductor Cloud workspaces.
> The relay intentionally depends on the local Conductor database, macOS
> Accessibility, local worktrees, and local `CONDUCTOR_PORT` allocations.

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
    only ever compared against that same column. localStorage remains the
    synchronous, offline-first copy, but `src/prefs.ts` now mirrors marks through
    `GET/PATCH /api/prefs` into `stateDir()/prefs.json`, merging each one by max.
    That survives a PWA origin change and syncs another authenticated device without
    ever writing Conductor's database. The session view marks *only*
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
  still has to press Enter. **That someone is the relay** (`src/firstprompt.ts` ▸ `FirstPromptQueue`),
  never the phone: a phone sleeps, iOS suspends a backgrounded PWA outright, and
  the delivery hook it used to run only looked at its parked set once per app
  launch, so prompts sat unsent until the next relaunch. Don't confuse that with
  "block the request": creation still returns as soon as the row exists (~2s;
  waiting for setup measured 30s+, past the phone's own 25s budget) and the queue
  delivers on its own schedule. Any model/effort/plan/fast choices ride in that
  same persisted entry and apply before the prompt. `send:true` opts an API caller
  into awaiting it.
  **And it presses Enter while the worktree is still building** — the one thing
  this queue had wrong. `setting_up` describes the worktree and the setup script,
  not the window: Conductor draws the workspace, its chat tab and its composer the
  moment the row exists, and **starts the agent 4-9s later with setup still
  running** — its own New workspace box does exactly that, on this repo's own
  chats. Holding out for `ready` cost 2m23s to 3m33s on the four workspaces one
  agent created in a burst (2026-08-25), so a caller that made a batch saw four
  workspaces with nothing sent and reported the send as broken. Measured against
  the live app the same day: workspace row at +1.6s with the chat row beside it,
  the relay's send back at +5.4s, the user row at +5.9s and the agent's answer at
  +12s, `state` reading `setting_up` throughout. So the send goes as soon as the
  chat row is there, and `ready` is now only where a failure starts to *count*: a
  send tried before it spends `earlyAttempts` (capped at **2** — each run holds
  `uiTurn` for tens of seconds, and a human tap queues behind it) and never the
  three below. Which means the worst an early send can do is what the queue did
  before it — deliver once the worktree is ready. The one dial is
  `sendImmediately` (default **true**, `POST /api/workspaces`, the phone's "Send
  immediately" checkbox and `create_workspace`'s `send_immediately`), and it is
  chosen per creation and frozen onto the entry, so a prompt already queued keeps
  the answer it was created with. The phone keeps its own choice in localStorage
  rather than in relay settings: it is that handset's habit, and it has to survive
  the relay updating itself under a cached PWA. Off is for a repo whose setup
  script installs what the agent's first move needs.
  Three properties hold it up: **one owner** (if the phone delivered too,
  `last_user_message_at` wouldn't save you — it's a read, not a lock, and both
  sides can read it null; the guard is still what makes *retrying* safe and what
  detects a prompt sent by hand from the Mac); **persistence** to
  `…/conductor-remote/first-prompts.json`, because `autoupdate` deliberately
  `exit()`s to reload and launchd restarts us mid-setup; and **giving up in
  public** — after 3 sends, or 15 minutes of a workspace that never turned ready
  (both counted only while the Mac is unlocked — the queue holds still behind
  the same lock probe the parked queue polls, via its `gate`), the entry flips
  to `failed` *and stays*, riding along on `/api/state` as
  `workspace.pending_prompt` so the chat can show the text with the reason and a
  Retry (`DELETE …/workspaces/:id/prompt` dismisses it). A waiting prompt shows
  the same way, because 30s of empty pane reads as "swallowed" and gets retyped
  — which is the same prompt sent twice.
- **A locked Mac parks the send instead of failing it** (`src/parked.ts` ▸
  `ParkedPromptQueue`). The lock screen hides the whole session from
  Accessibility, so while it is up no AppleScript write can land — and it is up
  precisely when the phone is the only thing talking. The phone's own retry
  budget (~a minute) is the wrong tool for a wait that routinely lasts hours, so
  the pieces hand off: `activateConductor` names the lock in ~2s (the fast path
  above), `deliverPrompt` stops retrying on that error (`writes.ts` ▸
  `lockBlocked`), and the send route parks the prompt — with any staged agent
  settings riding in the same request, so the two park and later apply
  *together* — in a persisted queue (`…/conductor-remote/parked-prompts.json`)
  and answers the phone `202 {parked:true}` in seconds. The queue polls
  `screenLocked()` (the node-side twin in `writes.ts` — stdlib JXA, no
  Accessibility grant) every 5s and delivers FIFO per chat on unlock, so two
  prompts parked into one conversation arrive in the order they were sent, and
  a push notification reports landed-or-failed either way — nobody is watching,
  that is the premise. The same three properties as the first-prompt queue:
  one owner (a manual send of the same text clears the parked copy —
  `forgetDelivered` — which is what keeps the chat's Retry from doubling it),
  persistence across the relay's self-restarts, and giving up in public — time
  spent locked costs nothing, three real failures *while unlocked* flip the
  entry to `failed` and it stays, visible the whole way as
  `workspace.parked_prompts` (the same queued bubble as a first prompt, its
  `reason` naming the lock) and dismissible via `DELETE …/sessions/:id/prompt`.
  **The relay will never unlock the Mac itself, and that is a macOS fact rather
  than a policy**: there is no unlock API, `loginwindow` turns on secure event
  input and hides the session from Accessibility, and the one input channel the
  lock screen still accepts is Apple's own Screen Sharing server — which would
  mean holding the account password on disk, next to a token, in a daemon that
  auto-updates itself from npm. "Only with `EXPOSE=tailnet`" doesn't rescue that:
  `readExposeMode()` falls back to **`public`**, and this posture has already
  healed itself back onto the open internet once (see the LaunchAgent-plist trap
  below). So the phone links to the unlock instead of performing it —
  **`vnc://<this host>`** (`web/src/lib/lock.ts` ▸ `unlockUrl`, built from
  `location.hostname`, since the PWA is already served from the Mac's own MagicDNS
  name), which hands off to whichever VNC client the phone has. Type the password
  there and the 5s lock poll flushes the queue on its own.
  **A parked bubble is not the only place that link belongs**, and for a while it
  was the only one that had it. A send parks; a *fork*, a stop, a status change and
  a model list have no queue to park into, so each of them ends at a refusal the
  phone must be able to act on — measured live 2026-09-01, a tap on Fork against a
  locked Mac answered with the lock sentence followed by
  `[window server: 6; screen: locked] [processes: conductor=0] [menus: Apple,
  Conductor, File, …]` in 11px red, with nothing to press. So the phrase every lock
  refusal starts with is declared once (`src/shared.ts` ▸ `MAC_LOCKED`,
  `isLockedError`) and read by both sides — the relay parks on it (`writes.ts` ▸
  `lockBlocked`), the phone draws `UnlockLink` beside it — and that evidence tail is
  cut on the way out of `json()` (`shared.ts` ▸ `withoutWindowEvidence`) and written
  to the log instead, which `/api/logs` serves to the same phone on request. The
  refusals themselves say "try again" rather than "send again", because three of the
  four callers aren't sends.
- **Only one UI operation at a time** (`writes.ts` ▸ `uiTurn`). Every AppleScript
  here drives Conductor's single shared window, so two overlapping runs interleave
  and land a prompt in whatever the other one focused — the exact failure every
  step's fail-closed assertion *cannot* catch, since each script's reads are true
  when it makes them. It was unreachable while every write was one person tapping
  one button; the first-prompt and parked-prompt queues, which send on their own
  schedule, are what made it reachable. **`src/mcp.ts` is what made the queue
  itself real**, and "there is never a real queue of them" stopped being true with
  it: N agents can now ask at once, so the lock carries a **bounded** queue
  (past `MAX_UI_QUEUE` a caller is refused with `UiBusyError` → HTTP 503, because a
  write costs seconds and a deep queue only guarantees the caller times out
  anyway — "busy, retry" is actionable where "took too long" is indistinguishable
  from a broken Conductor) and **two priorities** (`withUiPriority`, carried in an
  `AsyncLocalStorage` scope rather than through eight signatures that don't care:
  the phone is `interactive`, agents and both delivery queues are `background`, and
  background never overtakes a waiting interactive run, though it is never
  *interrupted* either). The subtle one: **release the lock before resolving the
  caller.** Settling first and cleaning up in a chained `.then` frees it one
  microtask late, so code that awaits a write and then reads `uiQueueDepth()` is
  told a run is still in flight when none is. `tests/ui-lock.test.ts` exists
  because `tsc` reads all of this happily and caught neither that bug nor the
  cascade behind it.
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
       rather than mapped to the nearest known cause. The probe itself is capped
       at 6s (`with timeout`): a wedged Conductor — seen live after a restart
       collided with its own relaunch — still answers deep links while hanging
       every AX read, and without the cap that surfaced as 28s of silence killed
       by the node-side ceiling ("took too long") instead of the `-1712` that
       refusalReason maps to "force-quit Conductor". If `reopen` has drawn
       nothing by ~3s the app isn't answering that event, so `dockClick`
       clicks the real Dock tile — delivered by the Dock through Conductor's own
       event loop, not as an Apple event we send. **There is no "New Window" to
       press**: Conductor is single-window and single-instance, so once reopen
       and the Dock click have both drawn nothing, restarting the app is the
       only lever left. That branch reports `windowEvidence()` — every process
       matching `Conductor` with its window count, the menu bar titles, and the
       window server's own count — because *which* process owns the on-screen
       window is the one fact that separates "genuinely windowless" from "we're
       addressing the wrong process". **"AX sees no window" is not "there is no
       window"**: the AX tree only shows the current Space, so a full-screen
       Conductor (its own Space) or a locked Mac reads 0 while the window
       exists — which is how the restart lever once quit a window the user had
       left open and wedged the relaunch. So `serverWindowCount()` (CGWindowList
       via a stdlib `osascript -l JavaScript` shell-out — owner and layer need
       no Screen Recording grant, only titles do) gets a veto: a window it can
       see blocks the restart, and `screenLocked()` (CGSessionCopyCurrentDictionary's
       `CGSSessionScreenIsLocked`, same channel) picks the words — "unlock the
       Mac" against the lock screen, "leave full screen" otherwise. **A locked
       screen blocks the restart even when no window exists anywhere**: in the
       live incident every relaunch fired behind the lock screen came up
       windowless and the last came up wedged (deep links answered, every AX
       read hung), so behind a lock the restart lever is not a lever — the
       error says to unlock instead. **And the lock is asked *first*, not last**:
       `activateConductor` checks `screenLocked()` right after the permission
       probe whenever that probe shows no window, because a locked Mac otherwise
       walks the whole ladder — patience budget, Dock click, evidence sweeps —
       and the attempt dies at the node-side ceiling as "took too long" before
       the lock branches below are ever reached (measured live 2026-08-14: the
       phone was told a timeout, never "locked"). The fast path errors in ~2s,
       stays *retryable* (not in `TERMINAL_ERRORS`) so `deliverPrompt`'s loop
       keeps polling it until the caller's deadline, and an unlock mid-budget
       lands the send with no retap — which is exactly how the live send
       recovered. It also runs before `activate`, so the relay never *launches*
       Conductor behind the lock screen. Only then does `restartConductor` quit and
       relaunch — **the only remaining lever**, and the one step here that can
       destroy work, so it is gated on `RELAY_ALLOW_RESTART`, which `server.ts`
       sets from a live DB read (`no workspace is 'working'`) — writes.ts must
       never decide this itself. It is **fire-and-forget**: a cold launch doesn't fit the phone's
       budget alongside the send, so it returns as soon as the relaunch starts
       and tells the phone to send again. "Open it on your Mac" is not advice a
       phone can act on.
    1. **Workspace** — open its own Conductor link (`openViaDeepLink`, see the
       deep-link bullet above): one URL carrying the workspace id and the chat id,
       and the whole ladder below exists only for a Conductor that doesn't answer
       it. Falling down that ladder: ask whether we're *already there*
       (`atTargetWorkspace`) — the pane header answers in ~0.5s where finding the
       row to press costs ~1s — then press its sidebar row (an `AXLink` named
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
    5. **Read the composer back after Enter** (`submitComposer`) — Conductor
       consumes the draft when it takes a prompt, so a box still holding the text
       is a keystroke that went nowhere, and that is the only receipt a run can
       collect about its own send. It is worth collecting because the other
       receipt, the transcript row, costs `CONFIRM_WINDOW_MS` (6s) and then a
       whole second run through activate/focus/tab/fill: measured from this Mac's
       relay logs, a send whose single fault was a first Enter Conductor ignored
       took **~10s** from the prompt appearing in the composer to it being sent,
       with the text on screen the whole way and exactly one user row written, so
       the keystroke was lost rather than late. Pressing again is safe *because*
       of the read — the prompt is still there, so nothing was consumed, so there
       is nothing to duplicate — and a Conductor too busy to have handled the
       first Enter is also too busy to answer an AX read, which blocks rather than
       returning stale text. The box is resolved once (`composerField`) and passed
       to both halves: finding it is a ~0.5s walk of the pane, while reading it
       back off the reference is ~10ms, so the whole confirm adds ~0.2s to a send
       that works.
       - **What the read buys is the *diagnosis*, not the second press.** The
         first occurrence in the wild (2026-09-01 16:59:57, `hyldmo/lamp-pairing-question`)
         had the box survive all three presses, and no send has ever been logged
         as rescued by a later one — so pressing is bounded at **two** and every
         press past the first is delay added to a send already failing. The value
         is that the caller now *knows*: `sendNeverStarted` (`writes.ts`) reads
         that sentence back and `deliverPrompt` checks the transcript **once**
         instead of watching it for the full 6s, because a run that never
         consumed the draft cannot have written a row. The one check stays — an
         *earlier* attempt's row may still be arriving, and typing over that is
         the duplicate the window exists to prevent. `tests/send-guards.test.ts`
         pins all three retry predicates, since each is a substring match on a
         sentence this repo writes and each fails silently.
       - **Why Enter gets ignored is still open.** The evidence says the box holds
         the text while Conductor acts as though it is empty, which is what a
         React-controlled composer looks like when the value was written past its
         change tracker — and the AX write is exactly that write. If that is it,
         the fix is to re-enter the text the way a person does (the existing
         `pasteComposer` fallback makes real key events) rather than to press
         Enter again. Not yet tried: the failure is intermittent, so it needs a
         reproduction before a fix can be believed.

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

    **What that confirm cannot see is a copy landed by a *different request*, and that
    is the duplicate the chats here actually hold** (`src/sendonce.ts`). The cursor is
    snapshotted when the request starts, so an earlier copy sits behind it. The failure
    is never the relay fumbling a send — it is the *answer* going missing: stale funnel
    ingress after a network change, a suspended phone, or the 75s client budget running
    out while the relay is still inside its own 55s one. The prompt is in Conductor, the
    phone never hears so, the bubble flips to failed, and Retry is right there. Checked
    over the whole history: **every retry `deliverPrompt` logged landed exactly once**,
    and the duplicate pairs carry no retry line at all, which is how the two were told
    apart. So the phone names the intent instead — `PendingMessage.id`, which Retry
    already reuses and a fresh send re-rolls, rides along as `clientId` and the relay
    answers a repeat with the first send's outcome. Keyed on that id and **never on the
    text**, so saying "yes" twice on purpose is still two prompts. Three properties: a
    **failure is never remembered** (or Retry does nothing for ten minutes and the
    prompt is lost rather than doubled, which is the worse half of the trade); a repeat
    arriving **while the first is still in flight** joins it rather than queueing a
    second UI run behind it; and **no key means no memo**, so an MCP caller or a PWA
    cached from before this gets exactly the old behaviour rather than a guess.

    **The bubble holding that prompt is now persisted too** (`web/src/lib/pending.ts`).
    The composer clears its draft the moment a send *starts*, so from then until a
    confirmation the optimistic bubble holds the only copy of what was typed — and it
    lived in memory alone, so the reload that follows a lost answer (or iOS discarding
    the backgrounded PWA, which is the one that actually happens) threw the text away
    in exactly the case it was worth keeping. A `sending` entry cannot come back as it
    left, because the request died with the page and nobody is awaiting it: it returns
    `error` flagged `interrupted`, which the transcript reconciles like a live one, so a
    prompt that *did* land shows up as a real user row and drops the bubble instead of
    parking a red one beside it. That reconciliation is also what covers the gap past
    the memo's 10-minute TTL, since a landed prompt's bubble is gone before Retry can be
    tapped. A failure the app *watched* happen is never reconciled that way — its red
    state is a fact about the send, and an identical prompt earlier in the chat must not
    retire it.

    The same verified path drives the chat's **agent settings** (`setAgentOptions`,
    `POST /api/sessions/:id/agent`). Their *values* are plain reads — `sessions`
    has `model`, provider-specific effort (`codex_thinking_level` for Codex,
    `claude_effort_level` for Claude), `fast_mode`, `permission_mode` — so only
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

    **Drafts and staged settings also have a host-side durable copy.**
    `web/src/lib/prefs.ts` keeps the legacy localStorage keys as the live/offline
    representation (including for an older cached PWA), and stores revision metadata
    beside them. A 700ms idle debounce, textarea blur, backgrounding, and reconnect
    flush snapshots to `stateDir()/prefs.json`; a 15s poll pulls another device's edits.
    Text and its staged agent patch share one revision. Clearing both writes a tombstone,
    so an offline stale browser cannot resurrect a prompt already sent elsewhere; a
    focused composer is protected from remote replacement, and the logical clock advances
    beyond every remote timestamp it observes. The token, optimistic pending sends, and
    the new-workspace "Send immediately" habit remain device-local on purpose.

    **Workspace status** (`setWorkspaceStatus`, `POST /api/workspaces/:id/status`)
    is the one write that touches no pane at all — it right-clicks the workspace's
    *sidebar row* (`AXShowMenu`), so what's on screen never changes. Conductor
    offers this nowhere else in its normal UI: **the menu bar has no status command
    and the palette has none either**, so the row menu (Mark as unread · Pin · Set
    status · Rename · Copy link · Archive) is the only production-safe lever. (A
    version-hashed workspace-service export is callable from Web Inspector, and a
    DOM app-actions bridge is present but internal-only; both are documented in
    `FINDINGS.md`, and neither is a stable external actuator.) With no fallback to
    fall back to, a
    **collapsed sidebar section** — which renders no rows, so its workspaces are
    invisible to Accessibility — is opened rather than reported: `expandSections`
    presses every folded header, the row scan runs again, and `restoreSections`
    folds back exactly what it opened, since the one thing this write promises is
    that the sidebar is where you left it. Two things make that safe. A section is
    read as folded by **shape, not by a chevron** (the webview exposes none): the
    rows are *siblings* of the header, so a header followed by an `AXLink` is open
    and one followed by its count badge, the next header, or nothing is shut. And
    what is carried across the write is the header's **name, never its element** —
    a System Events reference is an index into a tree that the status change
    re-renders, so folding back by handle would press whatever inherited the slot.
    The list itself is found by the same kind of test, its direct children being
    *only* `AXLink` and `AXStaticText`; the transcript hangs off the same web area
    and holds links of its own, so "the element with links in it" would hand back a
    message bubble and every press would land in one. One thing stays ambiguous and
    is left that way: a section holding *no* workspaces looks exactly like a folded
    one, so it gets opened and folded back for nothing — two presses that change
    nothing on screen, against no way to tell the two apart through Accessibility.
    Three more things bite: the row must be **scrolled into view**
    (`AXScrollToVisible`) or `AXShowMenu`
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
    while the user is at the Mac is contention, not a bug, and the answer is the
    ask-first rule below (Traps), never a re-run. Uncontended it was 6/6 at ~11s;
    typing in Conductor at the same time made it look flaky. It is faster now, and
    the reason is worth keeping: **finding the row used to be one Apple event per
    row**, which is 15s across the 50 workspaces here — more, on its own, than the
    whole write's old 25s budget, and what made the first cut of the section
    expansion time out. `sidebarRowsAndNames` reads every row's name in **two**
    events off the list element instead (~1s), which is only safe because the
    references and the names are two reads: the chosen row is asked its name again
    and must still answer the one it was picked for, since a sidebar that
    re-rendered between them shifts the index and lands the status on a neighbour.
    Measured after that, 2026-09-01: 8.2s through a folded section, 5.4s through an
    open one, both confirmed in the DB.

    **Stopping a turn** (`stopTurn`, `POST /api/sessions/:id/stop`) is the one
    write here that is a **keystroke on purpose**, against the file's own
    preference for AX presses. Conductor's own shortcut is **`⌘⇧⌫` ("Cancel
    agent")**, read off its Keyboard shortcuts dialog (`⌘/` ▸ Chat), and the
    composer's stop *button* cannot be addressed instead: it carries **no AX name,
    description, help or identifier**, so the only thing separating it from the
    send button beside it is its Tailwind class list — and while a chat is working
    **with a draft in the composer both buttons are on screen at once**, stop left,
    send right. "Press the last button in the composer" therefore *steers the
    running agent with half-typed text* in exactly the case someone reaches for
    stop. (The signature, if it is ever needed: send always carries `ml-1` plus a
    `bg-foreground*`; stop carries `border-border` and no `ml-1`.) The keystroke
    goes behind `⌘L` ("Focus chat input") so a focused terminal panel can't swallow
    it, and behind the same pane assertion a send makes — cancelling the wrong
    agent destroys work that was running fine, which is the same damage as landing
    a prompt in the wrong chat. **The branch is required, not optional**, since
    that assertion is the whole guard. The receipt is the DB, like agent settings:
    the route refuses to press anything unless `sessions.status` reads `working`
    first (a turn that ended a beat before the tap answers `alreadyIdle`, which is
    a success, not a red banner) and then waits for it to leave `working`. The
    phone mirrors the desktop composer exactly — working with an empty box shows
    only Stop, working with a draft shows Stop *and* Send — because Conductor
    allows steering and a Stop that replaced Send would take that away. A stopped
    turn ends with the frame `{"type":"error","content":"aborted by user"}`, which
    carries no `message.content` and so used to reach the phone as `transcript.ts`'s
    raw-JSON dump for unknown shapes — harmless while stopping needed a Mac, and the
    last line of every stopped chat once the phone could do it. Measured live: the
    stop lands in ~3s, the neighbouring chat in the same workspace keeps working,
    and the composer's draft survives the chord untouched.

    **Archiving a workspace** (`archiveWorkspace`, `POST /api/workspaces/:id/archive`)
    is the second keystroke here and the only write that destroys something: the
    worktree goes, and an agent still mid-turn goes with it. Conductor's chord is
    **`⌘⇧A`**, and it acts on *whatever workspace the pane is showing*, so the branch
    assertion a send makes is the entire guard — the branch is required, not
    optional, exactly as it is for the stop. The row menu carries an Archive item
    too, and it is not used: reaching it costs a sidebar scan plus two menu waits,
    against one chord on a pane the run has already had to open and check.
    **The second half of the question is Conductor's own**: a workspace with an agent
    working draws *"Agents are still running… Archiving will stop them"* over Cancel
    and **Stop agents and archive**, and an idle one draws nothing at all. So the
    script waits a bounded moment for that dialog, presses it *only* with
    `RELAY_ARCHIVE_AGENTS` set, and otherwise escapes and fails — ending someone
    else's turn is not something to infer from a tap that said Archive. It finds the
    button by the **pair** (a name mentioning the verb, with a Cancel beside it in the
    same bounded sweep), the way `waitForMenuWith` identifies a menu by an item it
    contains, since "the button called Archive" would press whatever else ever wears
    that word. The relay counts the working chats from the DB *before* touching the
    UI and refuses without `stopAgents`, so the phone's own dialog can quote the same
    sentence; the receipt is `workspaces.state` reading `archived`. An already-archived
    workspace answers `alreadyArchived` rather than 404 — a phone whose answer went
    missing retries, and the chat it lands back on is `ArchivedChat`, which was
    already there for search hits.
  - `sidecar` (opt-in, `WRITE_STRATEGY=sidecar`): JSON-RPC over Conductor's unix
    socket, addresses a session by id. Precise in principle but speaks a private
    `-v2-` protocol — the most update-fragile surface here, and **currently
    non-functional against Conductor 0.76**: the `query` schema drifted and idle
    sessions aren't live in the sidecar (they need a session-resume handshake), so
    the shipped payload fails loud (`ok:false`). Don't half-fix the schema — a
    `type:"query"` payload *validates then silently drops* the prompt. **A live
    `query` send injects a real prompt into a running agent; never auto-run it to
    "test."** Since `applescript` is now precise, sidecar buys nothing today.

- **Search is a read that builds an index, and it needs its own database.**
  `src/search.ts` full-text-searches the chat history, which is only possible because
  of one measurement: of the 3,106 MB in `session_messages.content`, the **prose is
  122 MB** — 4%. tool_result output is 799 MB, `type:"system"` frames 522 MB,
  tool_use arguments 162 MB. So it indexes what a person would actually search for
  (the prompts they typed, the agent's own words and its reasoning, via
  `parseMessage`, so a hit is always something the chat view would show) and skips
  the rest. Grepping the raw column would scan 3 GB to search 122 MB and would rank a
  file the agent happened to `cat` above the sentence explaining the decision.
  - **Thinking is two thirds of that prose, and skipping it was the original
    mistake.** Measured 2026-08-25: assistant text 36.9 MB / 93,189 blocks, typed
    prompts 2.6 MB / 19,432 rows, **thinking 82.7 MB / 102,776 blocks** — more than
    the other two together, and the half that says *why* (the same cut `split_chat`
    already makes). What hid it is a shape trap worth keeping: **a thinking block
    never shares a row with a text block** (0 of 102,773 rows carry both), so the
    prefilter written as `role='user' OR content LIKE '%"type":"text"%'` dropped
    100% of thinking rather than some of it, and the index looked complete.
    A thinking hit is labelled **`thought`** on the phone and `[thinking]` in
    `search_chats`, never "agent": the agent never said those words out loud, and a
    snippet tagged as its answer gets quoted back as one.
  **FTS5 ships inside `node:sqlite`** — porter stemming, `bm25()`, `snippet()`,
  `NEAR()` — so the index costs no runtime dependency; measured, the whole history
  builds in **12.3s** into ~208k chunks (230 MB) and queries answer in 25–137ms,
  inside the phone's 250ms search-as-you-type debounce, which is the only latency
  budget that binds. Re-measure rather than re-quote: the 7.6s/111k/1–7ms this file
  claimed before thinking was indexed had already drifted to 12–57ms on its own.
  Four things are load-bearing. The index lives in the relay's **own** file (`stateDir()/search.db`),
  never in `conductor.db`, and is disposable — delete it and the next start rebuilds
  it. The backfill cursor advances by the **last rowid scanned**, not the last one
  matched, or a caught-up index re-reads the whole 3 GB tail every poll looking for
  rows it already rejected. A phone query is never passed to `MATCH` raw: FTS5 reads
  `-`, `*`, `:`, `AND`, `NEAR` as syntax, so an unquoted apostrophe is a *parse
  error* rather than a poor result — `matchQuery` quotes every token and ORs them,
  leaving BM25 to rank, because someone reaching for a workspace is recalling it and
  not filtering it. **OR alone loses the query made of common words** (measured
  2026-09-01: "may i run the", a sentence one chat verifiably held, ranked nowhere in
  the top 300 chunks — OR rewards word density and nothing rewarded adjacency), so
  each unquoted run also enters as one OR'd FTS5 phrase term, whose rarity is its
  weight, and a `"quoted phrase"` — curly `“”` included, which is what iOS sends —
  is *required*: a typed quote is the one signal the user is filtering after all.
  And chunk hits are folded up into **workspaces** by summing only
  the best 3, which was measured rather than chosen: searching "removing adding lamp
  manual" for a chat that says "Add by name is gone. Removed the form", summing every
  hit put the right answer **9th** (a 32-message conversation about lamps won on
  volume), best-single-hit put it 5th, top-3 put it 5th and held up better across
  other queries. `Reads.searchTargets` / `findWorkspacesByName` deliberately drop the
  `state IN ('ready','setting_up')` filter the sidebar uses: **1,846 of the 1,886
  workspaces here are archived**, so search limited to the live list would miss
  almost everything. **And the phone can now read them**, which for a while it could
  not: `/api/state` carries only the live list, so `/w/<id>` answered "Workspace not
  found" and an archived hit had to render as a dead card. What makes reading one
  safe is that archiving deletes the *worktree*, not the conversation — the rows stay
  in `session_messages` — so `GET /api/workspaces/:id` (`reads.getAnyWorkspace`)
  answers for a workspace in any state with the same `SearchWorkspace` a result
  already carries, and `listSessions`/`getMessages` need nothing but ids.
  `SessionView` asks that route before it says "not found" and hands an archived
  answer to `ArchivedChat`. Two properties hold it up. **Every write is absent, not
  disabled** — a send needs a Conductor pane that no longer exists, a diff needs the
  deleted worktree, the status menu needs a sidebar row — and nothing there polls,
  because an archived chat has no next message; `/api/state` is still what notices an
  *unarchive*, which puts the live view back on its own. The one thing
  lexical search cannot do is bridge vocabulary: that lamp chat never contains the
  word "manual", so no amount of BM25 tuning ranks it first, and reranking can't
  help either since the document is never retrieved. That, not cost, is the case for
  embeddings if search ever needs them.

- **An attachment is a file plus a token, and nothing else** (`src/attachments.ts`) —
  which is the only reason the relay can make one. Conductor's composer stores an
  attached file as `@⟦<name>⟧(<the worktree-relative path, percent-encoded>)` in the
  prompt text, beside the file itself at `<worktree>/.context/attachments/<6 chars>/<name>`.
  There *is* an `attachments` table in `conductor.db`, and it is dead in the same way
  `workspaces.unread` is: 471 rows, last written 2026-05-19, **none of them in the
  `<id>/<name>` layout every attachment has used since**, and zero rows for attachments
  made today. So writing one costs no DB write, and the read-only rule at the top of
  this file survives intact. The near misses are quiet: `encodeURIComponent` encoding
  the slashes too *is* the format (tidying that away still sends, and simply isn't an
  attachment any more), and the brackets are `⟦⟧`, not the ASCII ones they resemble.
  `tests/attachments.test.ts` pins both against a token Conductor itself wrote,
  and pins the other half — that a name built from a **chat title**, which is free text
  a model wrote and which then gets joined onto a path, cannot climb out of the worktree.
  - **`split_chat` is what it exists for** (`POST /api/sessions/:id/split`): copy a chat
    into a fresh tab beside it, so a tangent asked inside a running conversation stops
    leaving three threads interleaved in one tab. Conductor's own "Fork to new tab"
    resumes the agent's real session, and is unreachable from here twice over — it lives
    on a hover menu over one message, so finding it means walking a transcript that gets
    more expensive the longer the chat is, which is the same unbounded-search cost the
    status menu's depth caps exist to avoid.
  - **What crosses is prose and reasoning, not tool calls**, and that cut is measured
    rather than chosen. Conductor's own concise copy drops thinking; its full copy brings
    the tool churn. On the chats here, thinking is the bigger half of a long one (p90:
    139 kB of thinking against 123 kB of prose; the largest, 300 kB against 101 kB), and
    it is the half that says *why*. Tool rows are ~98.8% of the raw bytes and the least
    re-readable. So `renderTranscript` takes one flag each — the same words `read_chat`
    already used, which is also why that tool stopped reading both off `include_tools`.
    Every cut is named in the file's own header and in the elision markers, because a
    transcript that quietly dropped half a chat reads exactly like a complete one.
  - **The other cut is where it stops.** By default the copy runs to the end, and
    `throughRowid` (`split_chat`'s `through`, a `read_chat`/`search_chats` cursor) ends it
    at one message instead, which is how a fork branches from *before* the conversation
    turned — the nearest this gets to Conductor's own per-message fork, and still a copy
    rather than a resumed session. It cuts on the **rowid**, because one source row yields
    several entries (reasoning, prose, the tool calls it made) that belong to one message
    and have to cross together, and because a rowid is what every pointer into a chat
    already is. A rowid this chat doesn't hold is a **409, never a silent cut**
    (`transcriptThrough`): a cursor copied from a different chat would otherwise stop the
    transcript at whatever row happened to sort below it, and the header would say nothing.
    That header names this cut too, and `elided.later` carries the count back to the caller.
    On the phone the cut is *where the button is*: the Fork control is drawn once per turn,
    under the answer that closed it (`transcript-actions.ts` ▸ `assistantTurnEnds` — an agent
    speaks several times inside one turn, and the three earlier ones would each cut a copy
    off mid-answer). The newest turn keeps its control at the foot of the transcript and
    passes no rowid, because an agent that speaks and then keeps working would otherwise
    leave those buttons stranded above the steps that came after them.
  - **It stops one step short of sending**, and that is not tidiness. ⌘T and a send are
    two UI turns (28s + 55s of ceiling) which together outlast every caller's budget,
    including the MCP client's 75s. Routing the composed prompt back through the ordinary
    send route also buys the retry loop, the transcript confirm and the parked queue for
    a locked Mac, none of which a second implementation would have. Which tab is the new
    one is decided by diffing the list against the one read *before* ⌘T, never by taking
    the newest: a sibling tab or another agent may have opened one in between.
  - **A token written into the composer is re-parsed**, which the DB cannot tell you (the
    attachment instruction an agent sees is built at send time and stored nowhere) and
    which one live split settled: the next agent was handed Conductor's own *"The user has
    attached these files. Read them before proceeding. - &lt;path&gt; (113.8 KB)"* ahead of the
    prompt, and read the file. The attachment token is the one canonical reference: a
    second prose path creates a duplicate link in Conductor's chat.
  - **⌘T alone does not open the tab, and it fails by opening something else.** The
    keystroke lands wherever focus is, so a focused terminal panel takes it and you get a
    new *terminal* — measured: the run reported success, `sessions` gained nothing, and
    `terminal_sessions` gained a row in the same workspace at that second. So `newChat`
    presses **⌘L ("Focus chat input") first**, exactly as `stopTurn` does with its own
    chord, and asserts the pane before either. Both chords are Conductor's own.

- **MCP is the same relay with an agent on the other end** (`src/mcp-tools.ts`).
  Seventeen tools, and **every one of them is an HTTP call to the
  running relay** — nothing here opens `conductor.db` and nothing here runs
  AppleScript. That is the load-bearing part, not a convenience: `uiTurn` is a
  *process-local* lock, so an MCP server that drove the UI itself would sit outside
  it and two agents focusing different workspaces would land each other's prompts.
  Routed through the relay, the phone, both delivery queues and every agent share
  one lock. Requests carry `x-relay-client: mcp`, which `server.ts` turns into
  `background` priority, so an agent never makes a human tap wait. It is hand-rolled
  **Two transports, one tool set.** `src/mcp.ts` is stdio (`conductor-remote mcp`),
  spawned as a child process by a local client; `POST /mcp` in `server.ts` is the
  Streamable HTTP transport for a client that can only reach a URL. They share
  `mcp-tools.ts` through an injected `call`, which is the only reason they cannot
  drift — verified by diffing both transports' output for the same query. The HTTP
  one calls the relay's own API **over loopback rather than reaching into
  `reads`/`writes`**: a sub-millisecond hop buys one code path, against carving every
  handler out of a 1000-line router. It is deliberately minimal — the server never
  initiates a message, so there is no SSE stream, `GET` answers 405 (which the spec
  allows) and no `Mcp-Session-Id` is issued. **A request carrying an `Origin` header
  is refused**: a real MCP client sends none and a browser cannot omit one, so that
  single check closes the DNS-rebinding hole the spec warns about without the relay
  needing to know its own hostname behind Tailscale's TLS. And note *who* can reach
  it is `EXPOSE`'s business, not the endpoint's: `tailnet` means any device on the
  tailnet from any network (not LAN-only), while a **hosted** client — an agent on
  someone else's servers — is on no tailnet and needs `public`, where the token is
  the only thing between the internet and `send_prompt`.
  rather than built on `@modelcontextprotocol/sdk` because stdio MCP is
  newline-delimited JSON-RPC 2.0 and the SDK is **91 packages / 24 MB** (express,
  hono, cors, jose) for a server that speaks neither HTTP nor OAuth — and this
  package auto-updates itself while holding a token that drives your Mac, so the
  supply-chain surface is not abstract. Two traps. **stdout is the wire**, so
  `console.log`/`console.info` are redirected to stderr at import: one stray line
  anywhere in the process is parsed as a protocol message and kills the session.
  And **end-of-stdin must drain, not exit** — a tool call is an await on the relay
  and a UI write takes tens of seconds, so exiting straight from the `close` event
  silently drops every in-flight reply, which looks exactly like a client that
  stopped listening.
  - **The tool set tracks `/api`, minus what only exists to back a button.** An agent
    needs no `merge` (it holds `gh`, and `send_prompt` can ask the agent that owns the
    branch), no push subscription, no settings editor and no repo icon. What it cannot
    reach any other way is what earns a tool: `set_agent_options`/`list_models`, because
    Conductor keeps model, effort, plan and fast in its composer and a prompt cannot
    touch them; `dismiss_prompt`, for a prompt the relay is still holding; `keep_awake`,
    which is what keeps this Mac reachable at all through a long unattended run;
    `split_chat`, because Conductor's own fork sits on a hover menu no agent can press;
    `archive_workspace`, so an agent that has finished can put its own workspace away
    (Conductor offers that nowhere a prompt can reach either), which is also why it is
    the one tool that refuses by default and needs `stop_agents` said out loud; and
    `relay_logs`. `list_workspaces` prints `pending_prompt`/`parked_prompts` for the same
    reason — those live in the relay's queues, not the DB, so an agent reading only
    `status` calls a stalled workspace idle and sends a second copy of the prompt already
    waiting on it.
  - **Register it as `conductor-remote`, never `conductor`.** Conductor injects an MCP
    server of its own into every agent it runs and that one already holds the name
    `conductor` (AskUserQuestion, DiffComment, GetWorkspaceDiff…). Registered under the
    same name, the two collide inside a Conductor workspace: Conductor's tools win, these
    seventeen are unreachable, and the *only* surviving trace is this server's
    `INSTRUCTIONS` text landing in the prompt — so it reads exactly like a tool set that
    should be there and isn't. User scope, too: a workspace is a fresh worktree, which a
    project-scoped entry keyed to the main checkout does not cover.

- **One set of types, because there are now three readers of the same JSON.** The
  phone, an MCP tool and the relay all describe the same rows, and for a while each
  kept its own copy: `web/src/lib/types.ts` was a 421-line hand mirror of `reads.ts`
  and friends, and `src/mcp-tools.ts` declared a third set inline at every
  `call<{…}>`. Nothing checked any of them — a field renamed on the relay typechecked
  cleanly on both sides and turned up as `undefined` on a phone, which is exactly how
  `workspace_diff` came to print `+undefined -undefined` for every file (it read
  `additions`/`deletions`; `git.ts` sends `added`/`removed`). So a shape that leaves
  the relay is declared **once**, in `src/wire.ts`, which re-exports the relay's own
  domain types under their wire names and adds the response envelopes the routes
  assemble; `web/src/lib/types.ts` is now `export type * from '…/src/wire.ts'`. This
  needs no dependency and no RPC framework: **`src/` and `web/src/` are one
  TypeScript project** (tsconfig.json includes both) and `verbatimModuleSyntax`
  erases a type-only import outright, so a type may live in the same file as the
  `node:sqlite` that produces it and none of it reaches the bundle.
  - **Types cross freely; values do not.** Two modules under `src/` may be imported
    as *values* by the web app, both stdlib-free on purpose. `src/shared.ts` holds
    what both sides must compute identically — `workspaceTitle` (three copies
    before, so the sidebar and a push notification could name one workspace two
    ways), `queryTokens`, the snippet hit markers, and the locked-Mac phrase both
    sides match on (`MAC_LOCKED`, above). Everything else is
    `import type`, enforced by `scripts/check-imports.ts`, because the near miss
    (`import { type X }`, inline rather than statement-level) still emits a real
    import. A third exception should be an argument, not an edit: each one is a
    promise that nothing under it ever reaches for Node.
  - **`src/routes.ts` is the other half of wire.ts: the paths, declared once.**
    `wire.ts` made the shapes impossible to disagree about and left the *addresses*
    written three times — a regex in `server.ts`, a template literal in
    `web/src/lib/api.ts`, another in `src/mcp-tools.ts`, 62 spellings of 27 paths.
    A renamed path typechecked in all three and surfaced as a 404 on a phone. Now
    one pattern serves both directions: `param()` splits `/api/sessions/:id/stop` at
    the placeholder to build `path(id)` for a client and the regex the relay matches
    with, so they cannot drift. Decoding happens in `routeParam`, which is what stops
    a handler forgetting `decodeURIComponent` on a repo name. **What the table cannot
    fix is renaming a path**: both sides derive from the one string, so a typo stays
    self-consistent and `tests/routes.test.ts` passes — and the phone runs from a
    service-worker cache while the relay updates itself, so an installed PWA can be a
    version behind. Treat a path rename as a breaking change to that older client.
  - **This is also the answer to "should we adopt tRPC", and `wire.ts` + `routes.ts`
    are that answer's cheap half.** Between them the shapes and the paths are each
    declared once, with no dependency, which is most of what tRPC was wanted for.
    What is left is worth stating accurately rather than dismissing: `@trpc/server`
    is genuinely zero-dependency, so the "91 packages" figure belongs to the MCP SDK
    and not to it. The real cost is a validator plus a `.meta`-to-MCP generator, two
    or three packages against a `dependencies: {}` tarball that auto-updates while
    holding a token that drives your Mac. Two things it also would not cover: the
    relay serves the PWA, the binary icon route and `/mcp` off the same port, so
    tRPC would sit *inside* `server.ts` rather than replace it (a footnote, not an
    objection); and `httpBatchLink` has no conditional-request path, while `json()`
    answers the phone's three forever-polls (1s, 2s, 2.5s) with a 304 today.
    - The measurement that decides it: of the 462 lines in the tool array, ~86 are
      `inputSchema` and 17 are route strings — the part `.meta` would generate. The
      other ~300 are agent-facing prose and **text** formatting, which exists because
      a tool returns rendered text sized for an agent's context, not the JSON the
      phone gets. Elsewhere the tool *is* the procedure, same in and same out, which
      is why `.meta` pays there and mostly does not here. Revisit past ~25 tools, or
      when something other than the phone becomes the primary client.

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
  enabling it fires once per already-idle workspace).
  - **A third one, because a turn ending is only news if someone asked for it.** An
    agent that schedules its own next turn — a `/loop` — ends a turn properly every few
    minutes for as long as it runs, and `status` cycles `working → idle` on each lap.
    Measured here: one looping chat pushed roughly every 5 minutes from early evening
    past midnight and again all morning, which was most of what the phone received at
    all. The tell is in the data rather than in a guess about intent: a turn is headed
    by a `session_messages` row with `queue_order` set, a lap the agent gave itself
    writes nothing at all, so what a person last did **sits still while `status` cycles**.
    So the lap after you type notifies and the ones after it are quiet, until you say the
    next thing. It takes **both** `turn_started_at` (the same read `listSessions` uses for
    the elapsed timer, now on `listSessionStates` too) **and `last_user_message_at`**: the
    first misses steering, because a message typed into a running turn carries no
    `queue_order`, so answering a question mid-lap would read as a lap nobody asked for
    and the turn would end unannounced. Two exemptions, both deliberate: `→ error` always
    fires (a loop that breaks is worth hearing about however it started), and a chat
    recording **neither** (dormant since before `queue_order` landed in May 2026) notifies
    every time, because with no evidence either way, silence is the dangerous default. The
    state machine is `TurnWatcher`, split out of the poll loop so `tests/notify.test.ts`
    can drive it a tick at a time.
  - **A fourth one: the chat already in front of you.** A turn ending on the screen you
    are reading is not news, and the drop has to happen on the relay. The service worker
    cannot swallow it — Safari treats a push that resolves without a notification as
    abuse and can revoke the subscription, which is why `push-sw.js` has no "suppress if
    the app is open" branch. So the phone tells the relay what it is looking at:
    `client.messages` carries this device's push id in `VIEWING_HEADER` (`src/shared.ts`,
    declared once because a misspelled header fails *silently* in both directions), the
    messages route stamps it (`noteViewing`), and `notifyAll` skips a device that
    `isReading` the chat it is about to announce. It rides the transcript poll rather
    than a heartbeat of its own: that poll already runs once a second for the chat on
    screen and for no other, so this costs no request and no timer. Three properties.
    The claim is **per device**, so a phone in a pocket still buzzes for a chat the
    tablet happens to be showing. It is sent **only while the page is visible**, the
    same test that moves the read mark, so a chat left on screen behind a locked phone
    is one you walked away from and its notification is the point. And it **expires**
    after `VIEWING_FRESH_MS` (10s) — the stamp lives in a plain Map, never in
    `push.json`, because a once-a-second write would rewrite that file at that rate and
    a claim means nothing after a restart.
    **What that cannot reach is a notification already delivered**, which is the one
    sitting on the lock screen when you open the chat from it. So the phone takes it
    down itself (`web/src/lib/push.ts` ▸ `closeNotifications`, driven by
    `useClearChatNotification`): the notifier tags per chat, so the tag *is* the session
    id and a sibling chat's own notification is left alone. It runs on the session's
    `updated_at` as well as on becoming visible — a turn ending here while the relay's
    claim had gone stale is exactly the notification that slips through, and resuming a
    backgrounded web app fires `visibilitychange` rather than remounting the view.
    `getNotifications` is absent in some browsers that can still *show* a notification,
    so a missing method is a no-op.

  Web Push is written out of
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
  the subscription for a silent push. **A tap has to be routed three ways, because
  on iOS the two obvious ones both fail silently**: the payload names the chat that
  ended (`/w/<workspace>?session=<chat>`, `notify.ts` ▸ `chatRoute`), and the worker
  posts that to a live page — the fast path, which keeps the token gate and a
  half-typed composer. But a backgrounded home-screen web app is *resumed on the
  screen it was left on*: `openWindow`'s path is ignored and a `postMessage` to a
  frozen page is dropped, which is what "tapping the notification does nothing"
  actually is (WebKit, reported iOS 17.1 through 18.x, still open). So the worker
  also **parks the target in Cache Storage**, and the app claims it on mount and on
  every return to the front (`hooks.ts` ▸ `usePushRouting`). Reading spends it —
  once, and only within 2 minutes — or the next launch would jump somewhere from a
  tap that already landed. The chat on screen lives in that same `?session=`
  parameter rather than in state, so a repeat notification for a chat you tabbed
  away from still wins: the two writers share one source of truth.
  - **And the tap owes the app a window, because nothing here happens by default.**
    A notification click fires the worker's handler and the app comes forward only
    because that handler asks it to, so any path out of it that asks for nothing is a
    tap the phone ignores outright — no window, no error, and a notification that reads
    like a dead area of the screen. Which is what shipped: the handler focused the first
    same-origin client and returned, and iOS hands back a *backgrounded* home-screen web
    app as a live window client whose `focus()` settles without foregrounding it, so
    `openWindow` below was reachable only when nothing was open at all. `focusClient`
    now answers whether the app really came up — a refusal, a resolve with nothing, and
    a client reporting itself unfocused all count as no — and `openWindow` is the
    fallback rather than the branch for a cold start. Getting that answer wrong the
    cheap way costs one extra `openWindow` on a platform that had already handled the
    tap; wrong the other way costs every tap. On an installed iOS web app `openWindow`
    resumes the one instance instead of adding a second, and the path it drops is
    exactly what the parked route above carries. `tests/push-click.test.ts` pins all of
    it, since a dead tap typechecks, lints, and reports nothing anywhere.

- **Keeping the Mac awake is the one write that needs *root*** — a fourth shape,
  touching neither the DB nor Conductor's UI. `pmset disablesleep` is the only lever
  that survives a closed lid (no power assertion reaches it, so Amphetamine and
  `caffeinate -i` are the wrong layer), it needs root, and **the LaunchAgent has no
  TTY to answer a sudo prompt** — which is the whole reason `nosleep setup`
  (`scripts/nosleep-setup.ts`) exists. It installs a root-owned helper plus a sudoers
  drop-in naming exactly that one path, and `src/nosleep.ts` drives it. Four traps,
  each of which turns the rule into passwordless root for everything if missed: the
  helper must live where **only root can write** — and that means *every ancestor*,
  not just the leaf, since renaming a parent replaces the path the rule names, so
  install checks the whole chain and refuses rather than half-securing the machine
  (`/usr/local/bin` is group-writable by `admin` on a Homebrew Mac, which is what
  disqualified it, and on Intel `/usr/local` itself is); it must be **copied out of the
  package**, never referenced inside it, or the self-updater hands root to every
  future published version (drift is *reported*, never silently refreshed); the rule
  carries **no argument wildcard**, so the helper validates its own input; and the
  drop-in is `visudo -cf`'d as a draft *and* the assembled set re-checked after,
  because a bad `/etc/sudoers.d` entry costs you `sudo` altogether. Two more that
  aren't about security: **`sudo -l` cannot detect NOPASSWD** for anyone holding
  blanket `(ALL) ALL` (measured — an unlisted `pmset` lists just as clean), so
  `helperReady()` runs the real path under `sudo -n -k` against a `--check` argument
  that exits before touching pmset; and **only one window may be armed**, because two
  would each capture the other's already-flipped values and "restore" those, leaving
  a Mac that can never sleep again — so arming *takes over*, waiting for the
  incumbent's restore before it captures. **That wait is bounded, so it fails
  closed**: 5s, then the arm is refused (exit 75). Capturing anyway is not a
  degraded outcome, it *is* the permanent failure, and it is reachable — an
  incumbent stuck in `pmset`, or a record whose pid was recycled, never answers the
  signal. Which is also why the pidfile carries the process's **start time** as a
  third field: a pid is not an identity, a SIGKILLed window leaves its record
  behind, and the helper runs as root, so matching on the number alone would let
  `--stop` SIGTERM whatever inherited it. The armed window is spawned **detached**
  (`autoupdate` exits to reload, and a plain child would die with it and quietly
  restore sleep), found again after a restart via `/var/run/…nosleep.pid`, and its
  liveness read through **EPERM, not success** — it runs as root, so `kill(pid,0)`
  from the relay is refused, and that refusal is the proof it's alive. **Ending the
  window has to put a shut Mac to sleep itself**: clamshell sleep is a lid-close
  *event*, not a state macOS re-checks, and the lid closed while `disablesleep` was
  up — so the helper's restore re-allows sleep without causing any, and a lid-closed
  Mac whose window ended (the phone's "Let it sleep", or the timer running out) sat
  awake indefinitely, which from the phone read as the button doing nothing. The
  relay follows the restore with `pmset sleepnow` — needs no root (only pmset
  *settings* do), so it lives in `nosleep.ts` rather than the installed helper and
  existing setups need no re-`setup` — gated on ioreg's `AppleClamshellState` (an
  open lid, or a desktop that has none, keeps restore-only, since forcing sleep on a
  Mac someone may be sitting at is worse than the bug) and fired ~2s *after* the
  disarm response, so the phone hears the answer before the network suspends. The
  expiry side (`watchNoSleepExpiry`) carries two guards of its own: a timer that
  fires long past its schedule is discarded (Node timers don't run while the Mac
  sleeps, so a late fire means someone just *woke* it — sleeping it again is the one
  wrong move), and a pidfile still present at fire time is a takeover, never "sleep
  anyway". The helper also owns a process-scoped `caffeinate -d` assertion by default.
  `ScreenSaverDaemon` checks `PreventUserIdleDisplaySleep` before it starts the idle
  screen saver, so the 20-minute automatic lock cannot cut off UI writes during an
  armed window. `PREVENT_SCREEN_LOCK` defaults on and the CLI can opt out through
  `config set prevent-screen-lock off`; the pidfile's fourth field records the applied mode
  so the phone warns from fact.
  The CLI warning names the physical-access cost. **A lid close still locks the session,
  and the assertion is not on that path at all** — measured from `loginwindow`'s own log
  (2026-09-01): keep-awake armed 20:16:24, lid shut 20:16:27 (`clamshell closed, but
  screen is not locked. Ignoring`), the display slept from that event 13s later and
  `LWDisplayWillSleepCallback` locked the session as `kLWLockFromDisplayDim`, with
  `PMDisplaySleepIsBlocked` never consulted — it guards the *screen saver*, which is a
  different trigger. So `disablesleep` keeps the machine running with the lid down and
  the session locks anyway ~16s in, which is the state this product is used in most.
  Those sends park (`src/parked.ts`), and the phone stops overclaiming: the card says
  *idle* screen lock rather than promising there is no lock, and `/api/settings` carries
  a live `screenLocked` (one probe per sheet open, never polled) so an armed window
  cannot say the lock is off while the lock screen is up. The only lever that would
  cover the lid is the user's own `askForPassword` (Require password after the display
  turns off), which is their security posture and not the relay's to flip.
- **The Mac's own Wi-Fi is readable only in the parts that don't matter.** The
  funnel watchdog can move this Mac onto a phone hotspot when its link dies
  (`src/wifi.ts`, opt-in via `src/settings.ts`), and the guards are the design: it
  fires only on `route -n get default` finding nothing, because **the associated SSID
  is not a usable signal** — macOS gates it behind Location Services and answers "not
  associated" while a default route is live on the same interface. Same reason
  `system_profiler SPAirPortDataType` is useless for naming: it scans, then redacts
  every SSID. **Hotspots cannot be detected**; macOS knows over Continuity/BLE, which
  is private, and the per-network store (`com.apple.wifi.known-networks.plist`) is
  `-rw------- root` — `looksLikeHotspot` is a name guess that only ever *sorts* a
  list. The one real fact available is world-readable: `AutoHotspotMode` in
  `com.apple.airport.preferences.plist` (System Settings ▸ Wi-Fi ▸ Auto-join
  Hotspot), and on `Never` macOS itself will not reach for your phone unprompted.
  The relay has one lever of its own for that case: when a join answers "Could
  not find network" (a hotspot doesn't broadcast until asked), the watchdog
  presses the hotspot's row in Control Center's Wi-Fi popover via Accessibility
  (`joinInstantHotspot` — writes.ts wraps the conductor.applescript handler),
  which wakes the phone's hotspot over Continuity exactly like clicking it. It
  needs an unlocked screen and an unattended Mac (any human click closes the
  popover), so Auto-Join `Automatic` remains the layer below it. Settings hold
  **SSIDs only** — passing a password to
  `networksetup` *writes* it into the keychain, so the relay only joins networks
  macOS already knows, and nothing secret reaches a file `/api/logs` might echo.

`sessions.id == claude_session_id` — Conductor is a GUI over Claude Code sessions.

## Commands

```bash
yarn verify   # typecheck + lint + repository checks + Vitest (slowest last) — before every commit
yarn test     # run the Vitest suite once
yarn test:watch # rerun affected Vitest tests while editing
yarn test:coverage # run Vitest with V8 text + HTML coverage reports
yarn check:repo # import-boundary and AppleScript source/toolchain validation
yarn fix      # Biome autofix (format + safe lints)
yarn build    # Vite → dist/ (the PWA the relay serves)
yarn build:node # tsc -p tsconfig.build.json → dist-node/, then copy src/*.applescript beside it
yarn start    # run the relay (node bin/cli.js)
yarn dev      # numux TUI (numux.config.ts): Vite :5173 (HMR) proxying /api → relay :8787
yarn deploy   # build + install/reload the login LaunchAgent, print phone URL
yarn service  # {status,restart,uninstall} the LaunchAgent
```

Automated verification has two layers. Vitest discovers the behavioral and integration
tests under `tests/`, supports focused/watch runs, reports individual failures, and can
collect V8 coverage. Two source/toolchain validators remain standalone scripts because
they inspect the repository rather than one runtime unit: the AppleScript compiler and
handler scan, and the relay/web import boundary.

- `scripts/check-applescript.ts` — `osacompile` parses `src/conductor.applescript`
  the way `osascript` will, and every `my handler()` call, in the script *and* in
  the TypeScript that appends to it, must resolve to an `on handler(`. AppleScript
  binds handler calls at run time, so those are two different failures and
  osacompile only sees one. The compile half is macOS-only, so CI runs it on its
  own lean `macos-latest` job (`check-applescript` — no yarn install, the script is
  stdlib-only, and it gates the release since the tarball ships the .applescript
  verbatim); the ubuntu job skips it, and the resolution half runs everywhere,
  which is what catches a rename in a pull request.
- `tests/nosleep.test.ts` — runs `NOSLEEP_BODY` against a **stub `pmset`** in a
  temp directory, pidfile and all, so it needs no root and never touches this
  machine's power settings. It asserts the property that costs something: the
  captured values always go back. A window that restores the *wrong* values leaves
  `disablesleep 1` with nothing armed, which reads as "working" everywhere and has
  no fix on the phone. Covers the ordinary window, a clean takeover, a takeover the
  incumbent refuses (must exit 75, must not capture), and a recycled pid (must not
  be signalled). Portable, so the ubuntu job runs it too.

- `tests/ui-lock.test.ts` — the UI lock's queue (`writes.ts` ▸ `uiTurn`), driven
  with timers instead of AppleScript, since it is the control flow being tested and
  not the scripts. It earns its place on cost: a run that fails to release the lock
  wedges **every** future write with no error and no fix from the phone, and a
  priority bug puts a human tap behind a minute of agent work. It found both bugs in
  the queue while that queue was being written. Portable, so the ubuntu job runs it.

- `tests/firstprompt.test.ts` — the first-prompt queue's two budgets
  (`src/firstprompt.ts` ▸ `step`). Sending before the worktree is ready means most of
  the failures the queue now sees are ones waiting fixes, so an early send spends
  `earlyAttempts` and only a post-`ready` one spends the three that give up in public.
  Get that split backwards and every slow repo greets its owner with a `failed` prompt
  Conductor would have taken a minute later — which is the regression the change itself
  could introduce, and it typechecks either way. `DeliveryDeps` is injected, so this
  needs no Mac, no Conductor and no relay; fake timers drive the queue's own schedule
  without waiting out production delays. Portable, so the ubuntu job runs it.

- `tests/sendonce.test.ts` — the send memo (`src/sendonce.ts`), which decides whether
  a prompt is typed into Conductor a second time. Both of its failure modes are pure
  control flow and both typecheck: remember too little and Retry doubles the prompt,
  which is the bug it was written for; remember a *failure* and Retry silently does
  nothing for ten minutes, so the prompt is lost rather than doubled, which is the worse
  of the two and the easier mistake to make while editing `keep`. Takes a function and a
  key, so it needs nothing else. Portable, so the ubuntu job runs it.

- `tests/pending.test.ts` — the phone's optimistic prompt store
  (`web/src/lib/pending.ts`), which since the composer clears its draft at send time
  holds the only copy of what someone typed until the relay confirms it. Both ways of
  getting the restore wrong are silent and cost the text: restore too little and a
  reload throws away the prompt that failed, which is the bug it was written for;
  restore a `sending` entry as it was stored and the bubble spins against a request
  that died with the page, so the one bubble carrying a Retry button never offers it.
  Also pins what must *not* be restored — a prompt older than a day, and another
  build's rows. localStorage is stubbed, so no browser. Portable, so the ubuntu job
  runs it.

- `tests/prefs.test.ts` + `tests/local-prefs.test.ts` — the two halves of durable
  PWA state. The host tests pin monotone read marks, last-write-wins drafts, deletion
  tie-breaking, sanitization and 0600 persistence. The browser tests pin legacy-key
  migration, origin recovery, focused-composer protection, clock skew, atomic
  text/agent intent and tombstone behavior. Both are stdlib/Map-backed and portable.

- `tests/notify.test.ts` — the notifier's state machine (`src/notify.ts` ▸
  `TurnWatcher`). Every rule in it is a rule about *not* buzzing a phone, which is why
  it is worth pinning: too eager is a nuisance you notice, too quiet is a notifier that
  has stopped and looks exactly like a Mac with nothing to report. Covers the baseline,
  the confirm-on-the-next-tick, a chat archived mid-turn, and the loop rule from both
  sides — the lap you asked for still fires, the laps the agent gave itself do not, and
  a chat with no turn head keeps the old behaviour. It also pins the reading claim
  (`noteViewing`/`isReading`): scoped to one device and one chat, moving with the reader
  rather than accumulating, and expiring once the poll that refreshes it stops — a window
  set too wide silently eats the notification for a phone put down mid-turn. Rows are
  injected and the claim is a plain Map, so no push store and no network. Portable, so
  the ubuntu job runs it.

- `tests/push-click.test.ts` — what a tapped notification does
  (`public/push-sw.js` ▸ `notificationclick`). Nothing about a click happens by default,
  so every way of leaving that handler without asking for a window is a tap the phone
  ignores: no window, no error, nothing logged on either side. That is how the shipped
  version of it survived a release — a focus that never foregrounded counted as success,
  and `openWindow` was unreachable while any client existed. So the cases are the four
  endings of a focus (landed, resolved unfocused, refused, resolved with nothing) plus
  no page at all, a foreign page, and a client whose URL won't parse, since a throw
  inside the scan is the same dead tap by another route. The worker source is loaded
  against a stubbed `self`, the way the browser loads it, so there is no browser and no
  service worker. Portable, so the ubuntu job runs it.

- `tests/routes.test.ts` — the `/api` route table (`src/routes.ts`). Every route
  matches the path it builds, the parameter survives encoding verbatim, no route answers
  another route's path, and a route answers its own method only. It earns its place on
  blast radius: the table is the one place a path is written now, read by the relay's
  matcher, the phone and the MCP tools at once, so a single wrong character takes out all
  three and `tsc` sees only a string. The collision check is the one ordering hides —
  whichever `if` is written first in the dispatcher wins, so a real overlap looks fine
  until someone reorders the file. Portable, so the ubuntu job runs it.

- `tests/attachments.test.ts` — the two halves of a Conductor attachment
  (`src/attachments.ts`), both of them strings all the way down. The token is *another
  app's* syntax, so it is asserted against one Conductor itself wrote, byte for byte:
  the percent-encoded slashes look like a bug and are the format, and `⟦⟧` are not the
  ASCII brackets they resemble. Tidy either and the prompt still sends, carrying a file
  nobody is told to read. The other half is that the file name comes from a **chat
  title** — free text a model wrote — and is then joined onto a path, so the test that
  matters is the one where a title engineered to climb out still lands inside the
  worktree. Portable, so the ubuntu job runs it.

- `tests/file-mentions.test.ts` / `tests/mention-render.test.tsx` — which words in a chat
  become source links (`web/src/lib/fileMentions.ts`). Both ways of getting it wrong are
  quiet: too eager and the transcript underlines ordinary prose, each tap opening a sheet
  that says the file is not there, which reads as a broken relay rather than a bad guess;
  too shy and the feature simply is not there, which nobody reports. The matcher is pure,
  so the first needs no relay and no browser. The second renders the chat to static markup
  for one fact that belongs to `react-markdown` rather than to us — inline code arrives with
  **no class**, which is how a mention is told apart from a fence — and it caught the fence
  with no info string coming through as a link. Portable, so the ubuntu job runs both.

- `scripts/check-imports.ts` — the relay/web boundary (see "One set of types" above).
  `web/src/**` may reach into `src/` only with a **statement-level** `import type`,
  and the trap it exists for is that the inline form looks identical and is not:
  under `verbatimModuleSyntax`, `import { type Workspace } from '…/reads.ts'` emits
  `import {} from '…/reads.ts'`, a live import of a module that opens SQLite. It
  typechecks, it lints, and it reaches the phone as a blank screen. It also asserts
  that `src/shared.ts` — the one module the web app may import a *value* from — pulls
  in no `node:` builtin, and that `src/wire.ts` declares types only. Portable, so the
  ubuntu job runs it.

Nothing else is tested. Verify a runtime change by curling the relay (see the
bind trap below), not by unit test.

## Traps (these will bite)

- **Ask before every run that drives this Mac's live UI.** Anything that opens,
  presses, or focuses real UI — Control Center's Wi-Fi popover, a sidebar row's
  status menu, Conductor's window — fights the person at the Mac: their next
  click closes what the run opened, the run steals focus from what they were
  doing, and both sides lose. Do not explain that away in a result ("contention,
  not a fault") and do not re-run; **ask the user for confirmation first, one ask
  per run**, saying what will appear on screen and for roughly how long, and wait
  for the yes. A yes covers exactly one run — not the topic, not the session.
  Reads that draw nothing (DB, git, CGWindowList, AX reads of existing windows)
  need no ask.
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
- **Workspace dev-server forwards are always tailnet-only, regardless of `EXPOSE`.**
  `src/dev-server.ts` presses Conductor's selected Run/Stop task through the same
  fail-closed Accessibility path as other writes; Conductor still owns the process
  and its cleanup. The relay discovers that process's allocated `CONDUCTOR_PORT`
  from `ps eww` only after Run (never log the snapshot — it contains environments
  and secrets), then gives it a separate root-mounted `tailscale serve` HTTPS port.
  **A start whose port already listens presses nothing** — forwarding is relay-only
  work, measured at **0.4s** against the Accessibility path's tens of seconds, and it
  steals no focus. That is what lets the phone open the tab from the same tap:
  WebKit drops a tap's activation after a few seconds, so `window.open` lands for
  this path and is refused for a cold start, which is why the Open control stays on
  screen and a refused window changes nothing.
  A discovered allocation is cached per workspace, and a **stopped** one has no
  allocation to cache, so the reads also share a single 5s `ps` snapshot: the phone
  polls this state every 2.5s per open chat and each snapshot costs ~650 kB and
  ~40ms here. Only a start reads fresh, because the task it just pressed is younger
  than any cached snapshot.
  A loopback bridge rewrites the public Host/Origin to localhost and tunnels raw
  WebSocket upgrades, which keeps strict Vite-style host checks and HMR working.
  `dev-forwards.json` is the ownership receipt: remove or replace only the exact
  Serve target it records, because every other mapping belongs to the user. It also
  records the bridge process and a private loopback challenge: `yarn dev` runs a
  second relay beside the LaunchAgent, and a node-watch restart must not steal the
  installed relay's live forward. On an owning relay restart, rebuild the ephemeral
  bridge only when that exact old mapping and the target process still exist;
  otherwise retain enough evidence for safe cleanup.
- **The LaunchAgent plist *is* the daemon's environment, and `process.env` in a shell is
  not.** `service install` bakes every runtime knob into the plist (`buildPlist`), so the
  daemon reads its port, its DB path and its Funnel posture from there and from nothing
  else. Two consequences. Reporting the daemon's configuration by reading your own shell's
  env is wrong, which is why `conductor-remote config` parses the plist instead (`plutil
  -convert json`) and prints the source of every value beside it. And anything the daemon
  reads on boot has to be in that plist *before* `reloadAgent()`, or the restart races the
  write: `EXPOSE` was persisted only to `stateDir()/expose`, by `ensureTailscale()`, which
  runs **after** the reload — so `--expose tailnet` started a daemon that still read
  `public`, armed the funnel watchdog against a Funnel that was one second from being
  switched off, and ~3 failed probes later healed it straight back onto the public
  internet. Reproduced against the old script in a sandboxed `HOME` with a stubbed
  `launchctl`; the plist launchd saw carried no `EXPOSE` at all. The posture is now
  resolved at the top of `install()` and baked like its nine siblings. `config` also
  cross-checks the configured posture against live `tailscale serve status`, because a
  relay that believes the wrong one repairs itself in the wrong direction.
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
  nothing. **Handler parameters are not exempt**: `findAxId`'s first argument was
  once named `container` (an SE dictionary word), so inside the tell it resolved
  as the term, the walk found nothing through an error-eating `try`, and a
  provably open Control Center popover read as "no popover" for a whole debugging
  session — `osacompile` and the handler check both pass it. Keep logic *outside*
  the tell and reach in via one-line helpers (`tabLabel`, `paneLabels`), or name
  variables `strip`/`pane`/`parentEl`. Nothing else in the toolchain reads this
  language, so run `yarn verify` after every edit.
  - **A `whose` clause is a *reference*, not a list, and reading elements out of
    one re-runs the filter per element.** So `repeat with l in (UI elements of b
    whose role is "AXLink")` is quadratic in the number of hits, and it looks
    exactly like the linear version. Measured on a 45-row sidebar: **10.8s** for
    the reference walk against **0.9s** for `get UI elements of b whose role is
    "AXLink"`, which forces the query once — ~220ms per element, all of it the
    filter being re-evaluated. `findSidebarRow` was **11.8s** and is now 1.8s, and
    that handler is the whole fallback focus path plus the only route to
    `setWorkspaceStatus`, which has no other lever. Anything reading *names*
    should also ask for them in bulk (`name of (UI elements of pane whose role is
    …)` is one round trip for all of them) rather than a `name of` per element,
    which is another ~18ms each — that is why `findSidebarRow` snapshots every row
    name once ahead of its four title candidates instead of re-reading per
    candidate. `get` on a query that yields one or two elements buys nothing
    measurable (`tabGroups` is unchanged at ~450ms); it is there so a workspace
    with twenty chat tabs doesn't discover the trap on its own.
  - **It is a real file, and that is load-bearing in two directions.** `writes.ts`
    reads it as a sibling of its own module (`import.meta.dirname`, the one place
    that may — see the `packageRoot()` rule below), so `yarn build:node` has to
    copy it next to the emitted JS; `tsc` only emits `.js`, and without that `cp`
    the published tarball boots to an ENOENT. It also used to live in a **TS
    template literal**, where a backtick in a comment terminated the string and
    `tsc` blamed a line tens of lines away — that trap is gone, and moving it back
    would bring it back.
  - **JXA shell-outs that return CF objects need two guards, and the compile
    check sees neither** (the JXA lives inside a string, so `osacompile` parses
    right past it — only running the probe tells you). `$.CFBridgingRelease` is
    an *inline*, not an exported symbol: calling it through `$` segfaults the
    osascript child (exit 139), which is how PR #85's window-server veto and
    lock probe shipped dead — every call read as "no opinion". And the
    CF-returning function itself must be rebound with
    `ObjC.bindFunction(name, ['id', […]])`, or JXA types its return as a bare
    pointer, `ObjC.deepUnwrap` answers `undefined`, and the `|| {}` fallback
    turns a locked Mac into a confident "unlocked" — the silent variant of the
    same wrong verdict. Both live probes (`serverWindowCount`, `screenLocked`,
    plus the node-side twin in `writes.ts`) carry the working pattern.
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
- **A touch iOS never ends leaves the drawer's drag holding the whole app.** The
  edge-swipe handler (`hooks.ts` ▸ `useEdgeSwipeDrawer`) paints an inline `transform`
  and keeps `tracking`/`horizontal`, both cleared on `touchend`/`touchcancel` — and
  iOS sends neither when the system claims the swipe or suspends the PWA mid-drag.
  The stale flags then make **every later `touchmove`, anywhere on the page**, skip
  the direction test, call `preventDefault()` and repaint the drawer: scrolling dies
  and taps never become clicks, so Close does nothing and only a relaunch clears it.
  (The drawer itself doesn't move much — Tailwind v4 compiles `-translate-x-full` to
  the *`translate`* property, so an inline `transform` composes with it instead of
  replacing it. The wedged input is the symptom, not a stuck panel.) So a new
  `touchstart` — and `visibilitychange`, the one silent ending we're told about —
  ends an orphaned gesture, and every committed open/close drops the inline
  overrides, which is what lets a tap undo a gesture that stranded them. Reproduce
  in any browser: fire `touchstart` + two `touchmove`s with no `touchend`, then check
  that the next plain vertical swipe comes back `defaultPrevented`.
- **Everything on screen is polled, so a transcript row must never re-render for
  free.** Three timers drive the chat — the transcript at 1s, sessions at 2s,
  `/api/state` at 2.5s — and any one of them changing a field re-renders
  `SessionView` and every row under it. A row renders `Markdown`, which is a full
  remark/rehype parse, so an unmemoised transcript re-parses every message it has
  ever shown, several times a minute. Measured on the 548-message chat at 6× CPU
  throttle: 267–401ms of blocked main thread per poll, worst frame 408ms, against
  0 long tasks and a 26ms worst frame once `Markdown`, `Entry` and `StepGroup` are
  `memo`'d. That block is what the spinners were stuttering on — CSS animation is
  the visible symptom, React is the cause. Two things hold the bail-outs up:
  `groupSteps` runs behind `useMemo` (its rows are rebuilt on every render
  otherwise, and a fresh array beats any shallow compare), and `StepGroup`
  compares its slice **element-wise** (`sameEntries`), or the live group growing by
  one step re-renders the whole backlog. Re-measure with `PerformanceObserver` on
  `longtask` under `Emulation.setCPUThrottlingRate` rather than on a Mac at full
  speed, where the whole thing hides inside one dropped frame.
  - **And the transcript is the one read that appends, so it must be single-flight**
    (`hooks.ts` ▸ `useTranscript`). Every other read on the phone is a react-query
    key, which replaces its data and dedupes per key; this one keeps a rowid cursor
    read when a tick starts and written when it answers, so two ticks overlapping
    that gap fetch from the same rowid and append the same rows twice. The mount is
    where it bites, because the first fetch carries the whole chat at cursor 0 and
    every 1s tick landing before it repeats the whole chat — on a workspace just
    created from the phone, whose only row is its first prompt, that renders as the
    prompt sent four or six times, the count being how many ticks the round trip
    outlasted (an iOS resume firing queued timers in a burst does it in one go).
    Nothing is sent twice, `session_messages` holds one row, and leaving the chat
    and coming back clears it — which is why it reads as a relay bug and is not one.
    Skipping a tick costs nothing: the cursor hasn't moved, so the next fetch carries
    what the skipped one would have.
  - **A tool's output is a different row from the tool call, so the pairing is the
    phone's job** (`web/src/lib/transcript-merge.ts`). Conductor writes the call in an
    assistant frame and the result in a later `type:"user"` one, and the transcript is
    polled by rowid — so anything the 1s tick outruns, which is every command worth
    watching, lands in a *later* fetch than the row it belongs to. A relay-side join
    would therefore only ever catch the fast tools. So the result travels as its own
    entry carrying the SDK's `tool_use` id (`toolUseId`, the only thing that pairs
    them) and `mergeEntries` folds it onto the call already on screen, which is what
    lets one row hold `rg -n needle src` and what it printed. Three properties.
    **Identity survives**: an untouched entry comes back as the same object, or the
    fold would re-render the whole backlog on every tick and undo the memoisation
    above. **An unpaired failure still shows** on its own — the old behaviour, and a
    dropped error reads as a step that worked — while an unpaired success is output
    with nothing to attach it to and goes. And **output is capped at 2,000 characters**
    (`MAX_OUTPUT_CHARS`), because a chat's first fetch carries its whole backlog:
    measured on the largest chat on this Mac, 664 results / 1,732 kB raw becomes
    569 kB, and the transcript goes from 703 kB to 1,482 kB (200 kB → 413 kB gzipped,
    which is what the phone actually pulls). Only the *phone* gets any of this.
    `renderTranscript` and `read_chat` print the call and leave the output behind, on
    the same measurement that keeps tool churn out of a fork: outputs are 799 MB of
    the 3,106 MB in `session_messages.content` and the least re-readable part of it.
  - **A result arrives in whatever shape its tool answered in, and three of the five
    shapes used to render as nothing.** Measured over the 40,000 most recent result
    blocks here: 35,709 plain strings and 753 text blocks were read, while **3,917
    results showed as an empty step** — 3,120 of them Conductor's own edit result
    (`{status, diffString}`), 205 a `tool_reference` list, 80 an image. So an edit now
    shows its **diff**, coloured by the same `Patch` the workspace diff uses (extracted
    to `web/src/components/Patch.tsx`, because a patch that reads differently in two
    places reads as two different changes), a tool search names what it found, and an
    unknown shape falls back to its own JSON rather than to silence, which is what keeps
    Conductor drift visible. **Images are the one output that stays behind a route**
    (`routes.ts` ▸ `toolImage`, `<message rowid>.<image number in that row>`): each is
    ~100 kB of base64 sitting in the row, so shipping them inside a transcript that
    already carries a whole chat is the one thing the cap above exists to prevent. The
    entry carries references, `ToolEntry` holds its own open state, and the fetch happens
    only for a step someone opened. That numbering is why `parseMessage` and `toolImageAt`
    live in one file: they must walk a row's image blocks in the same order, or the
    reference finds the wrong picture.
  - **Syntax colour costs bundle bytes, not frames** (`web/src/lib/highlight.ts`).
    Measured against 800 real Bash commands out of `session_messages` (median 195
    chars) and this repo's own files: highlight.js tokenises the median command in
    **0.011ms** and a 500-line file in **2.4ms**, so the runtime side never reaches
    the poll loop above. The bytes are the whole decision, because the service worker
    precaches the bundle and the phone re-downloads it on every release. Gzipped,
    against the app's own 254 kB: **eleven languages cost 22.8 kB**, highlight.js's
    full set costs 313 kB, Shiki's smallest useful build costs 113 kB and tokenises
    20× slower (0.24ms per command, 47ms per file, plus 36ms compiling grammars
    before the first line is coloured). So the languages are registered one at a time
    and anything unregistered renders plain, exactly as it did before.
    Three places show it and each gets it differently. A **Bash step** colours only in
    the *open* body — the closed row is one truncated line, and colouring it would
    tokenise every step on a chat's first paint (256 Bash calls in the largest chat
    here). A **fenced block** in a message rides `Markdown`'s existing memo, so it
    tokenises once per message ever shown. The **source preview** is the one that
    needs `lowlight` rather than bare highlight.js: it draws its own element per line
    for the gutter, and a token routinely covers several lines (a block comment, a
    template literal), so highlight.js's HTML string cannot be split at `\n` without
    cutting through the tag. `splitLines` cuts the *tree* and re-opens the enclosing
    spans on the next line; `tests/highlight.test.ts` pins that the lines put the
    input back together and that blank ones survive, because a line lost there
    renumbers every line below it and still looks like an ordinary file. Token colours
    come from the app's own palette in `index.css`, not from a shipped theme.
    The **workspace diff stays plain**: per-line highlighting of a 400 kB patch
    (`MAX_PATCH_BYTES`) measured 77ms and ~20,000 extra spans, and every line would be
    highlighted alone, so a block comment loses its colour after the first line anyway.
  - **A file an agent names in prose is a link too, and only when the file is really
    there** (`web/src/lib/fileMentions.ts`). Agents write paths in backticks all day —
    "updated `tests/foo.ts`", "plan written to `~/.gstack/plan.md`" — and every one of
    them was dead text, while the same path written as a Markdown link has opened the
    source sheet for a while (`Markdown.tsx` ▸ `sourceReference`). The rule that keeps
    this from underlining half the transcript is **existence, not shape**: inline code
    holds far more than paths (`yarn build`, `sessions.status`, `Array.map`), so a
    worktree-relative mention is matched against the worktree's own file list
    (`GET /api/workspaces/:id/files`, `git.ts` ▸ `listSourceFiles`: tracked *plus*
    untracked-not-ignored, since an agent names a file in the same message that created
    it) and an ambiguous one links nowhere — `types.ts` naming two files is not a fact
    about either. Measured over the real chats here, that leaves 45 links in 575 code
    spans on one workspace and 11 in 88 on another, every one of them a file that
    exists; the misses are `scripts/dev.ts` in a worktree where it was deleted and
    `dev-forwards.json`, which lives in the relay's state dir. The list costs one
    request per workspace (143–746 paths here, 3–27 kB before gzip, previewable
    extensions only) and is deliberately not polled.
    An **absolute** path is the exception and links on shape alone: `/Users/…` may
    point at another workspace and `~/…` at a plan file, so there is no list to check
    it against — **the relay decides whether it may be opened**, exactly as it does for
    a Markdown link, and `~` is expanded in `file-preview.ts` because the phone has no
    idea which account the relay runs as. That half needs no workspace, so it is the
    fallback when there is no resolver in context — an archived chat's `~/plan.md` is as
    readable as ever, only its worktree is gone, and the same sentence must not link in
    one chat and not in the one beside it. Which is why that route now **says a refusal
    is a refusal**: a home path is out of bounds on a public funnel, and answering
    "source file not found" for a file sitting right there sends people hunting. It
    discloses nothing, because the 403 is computed from the path and the posture and is
    the same answer whether or not the file exists.
    Two traps. A **fenced block with no info string reaches `ChatCode` with no class
    either**, exactly like an inline span, so the mention text is *not* trimmed — its
    trailing newline is the whole of what tells a code block from `` `src/git.ts` ``.
    And the resolver arrives by **context**, not by prop: `ChatCode` is one entry in a
    static component map nothing threads props through, and a context read is the one
    thing that updates past `Markdown`'s `memo` when the file list lands after the
    first paint. `tests/mention-render.test.tsx` renders the chat to static markup for
    the fence trap alone — it caught it — because everything else about it typechecks
    and the failure is silent in both directions.
    **A link the sanitiser emptied is not a link, and `ChatLink` now says so.**
    react-markdown keeps only `http(s)`, `irc(s)`, `mailto` and `xmpp`, and rewrites every
    other scheme to `href=""` — which a browser follows to the page it is already on, so
    on a phone it is a tap that reloads the PWA and reads as a broken link. Nobody has to
    write a bad link to reach it: gstack appends `<gstack-qid:{question_id}>` to a review
    question on the belief that angle brackets hide it, and CommonMark reads
    `<scheme:rest>` as an **autolink**, so the marker arrives visible *and* clickable. An
    empty href now renders as text.
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
  merge-button take was cleared.)
- **The relay updates itself fine; the phone is what gets stuck.** `src/autoupdate.ts`
  pulls a new version and serves a fresh `dist/`, but an installed iOS home-screen PWA
  rarely re-fetches `sw.js` on its own, so it can keep running a stale precached shell
  while `/api/state` still reports the new relay version — the version *label* comes
  over the network, the *code* from the SW precache, so they disagree. Three layers
  answer that, in `web/src/components/ReloadPrompt.tsx` + `public/self-heal.js`:
  (1) `registerType: 'prompt'` (**not** `autoUpdate`, which reloads mid-compose) plus a
  60s `registration.update()` poll to discover a waiting worker; (2) a **version gate** —
  the app bakes its build version in as `__APP_VERSION__` (`vite.config.ts` ▸ `define`,
  read from the same `package.json` the relay reports), and when `/api/state`'s `version`
  is ahead it forces an immediate `update()`, so recovery takes one state-poll rather
  than 60s, and the Connect sheet shows `relay vX · app vY · update pending`;
  (3) `self-heal.js` runs before the bundle and, if a removed hashed asset fails to load
  (the relay's SPA fallback answers `/assets/*` with `index.html` as `text/html`, so the
  MIME check trips), unregisters the SW, clears the caches and hard-reloads with a `_v=`
  cache-bust. A client too stale to carry *any* of this needs one manual kick (re-add to
  the home screen); after that it heals itself. There is no `scripts/fix-sw.ts` dance
  here — plain Vite already gives `index.html` a content-hash precache revision, so a
  no-op build doesn't re-fire the banner.
- **If a Conductor update breaks a read**, re-derive from the DB schema; if it
  breaks the sidecar write, re-derive from `conductor-runtime`. Both procedures
  are in ARCHITECTURE ▸ "Re-deriving Conductor internals."

## Conventions

- **Biome** formats and lints (`biome.jsonc`): tabs, single quotes, no semicolons,
  no trailing commas, 120 cols, arrow parens as-needed. Don't hand-format — run `yarn fix`.
- **TS strict**, `verbatimModuleSyntax` (use `import type`), `.ts`/`.tsx` extensions
  in imports are required (`allowImportingTsExtensions`).
- **Layout:** `src/` = Node relay (server, db, reads, git, transcript, sidecar,
  writes, config) plus `conductor.applescript`, the UI script `writes.ts` runs.
  Two files there are read by the phone as well: `src/wire.ts` (the `/api` contract,
  types only), plus `src/shared.ts` and `src/routes.ts` (both stdlib-free, the only
  value imports the web app may make) — see "One set of types".
  `web/` = Vite-root React PWA (`web/src/`). `public/` = static
  PWA assets at the **repo root** (not under `web/`) so Conductor's repo-icon lookup
  finds them (`vite.config.ts` sets `publicDir: '../public'`); `scripts/` = dev,
  icon-gen, service installer, AppleScript check. `dist/` = build output
  (gitignored, relay-served). Per-file map in [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Utility scripts** run under plain `node` (default type-stripping), stdlib-only —
  keep them strip-clean too (no param-property constructors/enums/namespaces).
- **Commit author** is the GitHub noreply address (privacy) — keep it for public commits.
