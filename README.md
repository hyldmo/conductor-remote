# conductor-remote

A phone control panel for your **local** Conductor agents. Monitor every
workspace, read live transcripts, view diffs, and send prompts — from your
phone, over your Tailnet, no cloud, no App Store.

Installable as a PWA (Add to Home Screen). Reads ride Conductor's on-disk SQLite

<img width="600" height="800" alt="demo-workspaces" src="https://github.com/user-attachments/assets/e098f964-29b2-4614-b200-9dc977799eb8" />

## Install

Needs [Conductor](https://conductor.build) running on the same Mac, Node ≥ 24, and
[Tailscale](https://tailscale.com) on the Mac + phone. Then:

```bash
npm i -g conductor-remote
conductor-remote service install    # run on login; prints your phone URL
```

**Private tailnet only?** Pass `--expose tailnet` to skip public Funnel, so the URL
is reachable only from devices logged into your tailnet:

```bash
conductor-remote service install --expose tailnet
```

The choice is remembered across re-deploys; see **Reachability** below for the trade-off.

Or the one-liner (checks Node, offers `brew install node` if missing, installs,
registers the service):

```bash
curl -fsSL https://raw.githubusercontent.com/hyldmo/conductor-remote/main/install.sh | bash
```

The published package is **dependency-free** — no build step and no native addons
on your machine, so `npm i -g` finishes in about a second. `service install`
prints a phone URL with an embedded token; open it and **Add to Home Screen**.
Manage the service with `conductor-remote service status|restart|uninstall`.

`conductor-remote config` prints what the daemon is **actually** configured with and
where each value came from, then cross-checks the configured reachability against what
Tailscale is doing. Change one value with `conductor-remote config set <setting> <value>`.
The setter preserves the other values in the LaunchAgent plist and restarts the relay.

**Install flags.** `service install` takes flags for the install-time knobs (each
also settable via the env var in brackets — the flag wins when both are given).
Run `conductor-remote --help` for the full list. The common ones:

| Flag | Env | Purpose |
| --- | --- | --- |
| `--expose public\|tailnet` | `EXPOSE` | Reachability (public Funnel default, or tailnet-only) |
| `--port <n>` | `RELAY_PORT` | Listen port (default `8787`) |
| `--token <secret>` | `RELAY_TOKEN` | Pin the shared secret (default: generated + persisted) |
| `--write-strategy <s>` | `WRITE_STRATEGY` | `applescript` (default) or `sidecar` |
| `--prevent-screen-lock on\|off` | `PREVENT_SCREEN_LOCK` | Block the automatic lock during nosleep windows (default `on`) |

**Reachability (`--expose`).** By default the URL is exposed publicly via
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) — reachable from any
browser, gated by the embedded 128-bit token (so the phone needs **no** Tailscale
app). Funnel must be enabled once for your tailnet (Admin console). To keep it
tailnet-only instead (devices logged into your tailnet, via `tailscale serve`),
install with `--expose tailnet` (or `EXPOSE=tailnet`). The choice is remembered
across re-deploys.

The relay sits on `:443` by default. When another service already holds that
port (Funnel is per port, and some webhooks only ever dial 443), the deploy leaves
it alone and mounts the relay on the next free port instead, so the phone URL can
read `https://<node>:8787/`. `service status` and `config` report whichever
port is live; a mapping already in place is kept wherever it is.

## Architecture

```
 Phone PWA  ──HTTP/poll──►  Relay (Node, on the Mac, bound to Tailscale)
 (React, installable)                 │
                                      ├─ reads:  node:sqlite ⟶ conductor.db   (workspaces, sessions, transcripts)
                                      ├─ reads:  git ⟶ each worktree           (diffs vs target branch)
                                      ├─ usage: provider CLIs ⟶ rolling plan limits (no model prompt)
                                      ├─ writes: Actuator ⟶ Conductor
                                      │          ├─ applescript (default): osascript ⟶ focused session
                                      │          └─ sidecar (opt-in):      unix socket ⟶ exact session
                                      ├─ dev:    Run/Stop ⟶ CONDUCTOR_PORT ⟶ tailnet-only HTTPS
                                      └─ push:   turn ended ⟶ Web Push ⟶ your lock screen
```

- **Two halves.** A **Node relay** on the Mac (reads Conductor's state, drives
  the write path) and a **React PWA** the phone installs. Vite builds the PWA to
  `dist/`, which the relay serves.
- **Reads are durable.** No Conductor API, no injection — the SQLite schema and
  git worktrees outlive UI changes.
- **Plan usage is prompt-free.** The usage gauge asks Conductor's bundled Claude
  and Codex CLIs for structured rolling limits only while the sheet is open, then
  caches the result for a minute. Cursor/OpenCode say why no plan quota is available.
- **Writes are the one fragile nerve** and are isolated behind a swappable
  `Actuator` (`src/writes.ts`).
- **Notifications ride the durable side.** The relay watches the same SQLite for
  turns ending and sends a Web Push straight to the phone — no Conductor process
  involved, and it works with the app closed.

## Stack

React 19 · React Router 7 · Vite 7 · Tailwind v4 · `vite-plugin-pwa` · TanStack
Query · Zustand · Biome · lucide. The relay is dependency-free Node 24
(`node:sqlite` + native TS type-stripping).

## Requirements

- Node ≥ 24. ([Yarn](https://yarnpkg.com) — Berry, the repo pins `yarn@4` — is
  only needed to run from source; the published package installs with plain npm.)
- Conductor running on the same Mac.
- [Tailscale](https://tailscale.com) on the Mac and the phone (or any shared
  private network) to reach the relay.
- For the **write** path only: macOS **Accessibility** permission for whatever
  runs the relay (Terminal/node) — System Settings ▸ Privacy & Security ▸
  Accessibility. Reads work without it.

## Run from source

For contributing or running an unpublished checkout (the `npm i -g` path above
needs neither a clone nor a build):

```bash
git clone https://github.com/hyldmo/conductor-remote.git
cd conductor-remote
yarn install
yarn build          # builds the PWA into dist/
yarn start          # serves dist/ + the API (node bin/cli.js)
```

Or in one step: `yarn preview` (build + start). For live development with HMR,
`yarn dev` runs Vite (`:5173`, proxying `/api`) alongside the relay in a
[numux](https://github.com/hyldmo/numux) TUI — one tab each, `numux.config.ts`
picks the ports (needs [Bun](https://bun.sh) on PATH). Open the URL the relay tab
prints: it points at Vite's origin and carries the token, which Vite can't print.

The relay prints a phone URL with an embedded token:

```
Open on your phone (same Tailnet):
  http://100.x.y.z:8787/#token=<generated>
```

Open that on the phone and **Add to Home Screen**. The token is stored in
`localStorage`; every `/api/*` call carries it, so other devices on the LAN
can't read your sessions.

Read marks and unsent prompt drafts stay local-first for offline use and are also
mirrored to `~/Library/Application Support/conductor-remote/prefs.json`. A draft
includes its ready attachments and staged agent choices; file bytes stay in the
workspace or the relay's pre-workspace staging directory. That durable copy survives
a PWA hostname/origin change and restores the same state on another authenticated
device. Access tokens, uploads still in flight, and in-flight send state remain
device-local.

### Deploy (run on login as a background service)

The relay must run on the Mac that runs Conductor — it reads the local state DB
and git worktrees and drives the local sidecar/AX write path, so there is
nothing to host in the cloud. "Deployment" here means installing it as a macOS
**LaunchAgent** that starts on login and restarts if it dies:

```bash
yarn deploy            # build dist/ + install & start the LaunchAgent, prints the phone URL
yarn service status    # state + pid + phone URL
yarn service restart   # e.g. after Tailscale comes up late, or a code change
yarn service uninstall # tear it down
```

From a global install the same commands are `conductor-remote service
<status|restart|uninstall>` (and `conductor-remote service install` in place of
`yarn deploy`, since `dist/` ships prebuilt in the package).

The token is now **persisted** (`~/Library/Application Support/conductor-remote/token`),
so the home-screen URL stays valid across restarts and reboots. Logs land in
`~/Library/Logs/conductor-remote/`. Two caveats: the agent bakes the absolute
`node` path at install time — re-run `yarn deploy` after an nvm node upgrade —
and the AppleScript write path needs Accessibility permission granted to that
`node` binary (System Settings ▸ Privacy & Security ▸ Accessibility).

### Config (env / flags)

Each knob is an env var (honored by `yarn start` and `service install`) and, for
`service install`, the CLI flag in the second column. A flag wins over the ambient
env. `EXPOSE`/`--expose` is documented under Install above.

`service install` bakes these into the LaunchAgent plist, so that plist is the daemon's
environment. Use `config set` for later changes. `conductor-remote config` reads them back:

```
$ conductor-remote config
plist:  ~/Library/LaunchAgents/no.adluna.conductor-remote.plist
state:  ~/Library/Application Support/conductor-remote
daemon: running  (pid 85882)

  expose                    tailnet      plist
  port                      8787         default
  write-strategy            applescript  default
  …
  token                     99f6…6b38    token file

  ✓ tailscale agrees: serve only (tailnet)
```

```bash
conductor-remote config set port 9000
conductor-remote config set write-strategy sidecar
```

| Var | Flag | Default | Purpose |
| --- | --- | --- | --- |
| `RELAY_PORT` | `--port` | `8787` | Listen port |
| `RELAY_HOST` | `--host` | auto (Tailscale `100.x`, else `127.0.0.1`) | Bind address |
| `RELAY_TOKEN` | `--token` | persisted (auto-generated, reused across restarts) | Override the shared secret |
| `WRITE_STRATEGY` | `--write-strategy` | `applescript` | `applescript` (focused session) or `sidecar` (precise per-session — see below) |
| `PREVENT_SCREEN_LOCK` | `--prevent-screen-lock` | `on` | Block the automatic lock during nosleep windows |
| `AUTO_UPDATE` | `--auto-update` | `auto` | Self-update mode: `auto` / `check` / `off` |
| `CONDUCTOR_DB` | `--db` | `~/Library/Application Support/com.conductor.app/conductor.db` | State DB |
| `CONDUCTOR_WORKSPACES` | `--workspaces` | `~/conductor/workspaces` | Worktree root |
| `PUSH_NOTIFY` | — | `on` | `off` disables push notifications entirely |
| `PUSH_SUBJECT` | — | the project's repo URL | VAPID `sub` (a `mailto:` or `https:` URL identifying the sender) |

The token is auto-generated once and persisted, so the home-screen icon keeps
working across restarts without any env var. To pin a specific secret (e.g. to
share a known URL), set `RELAY_TOKEN`:

```bash
RELAY_TOKEN=$(openssl rand -hex 16) yarn start
```

## What works today

- ✅ Live list of active workspaces with agent status (working / idle / done),
  repo, branch, model, per-chat context %, and an unread mark on any workspace whose chats
  finished something you haven't looked at — reading it *on the phone* clears it,
  which Conductor itself only does when you open the workspace on the Mac. Tap a tab's
  context percentage or the segmented composer donut beside Attachments for estimated
  initial/chat/thinking/tool-call composition and the approximate payload size of each
  full-history fork format.
- ✅ **Models** panel — change Claude Code and Codex defaults for new chats, written
  to `~/.conductor/settings.toml`, and see rolling plan usage from their structured
  CLI protocols with no model request. Cursor Agent and OpenCode keep their own
  provider cards without pretending local accounting is a subscription limit.
- ✅ Live transcript per session (assistant text, tool calls, queued messages),
  incremental polling.
- ✅ **Fork a chat** with the selected response only, a concise transcript,
  reasoning, or the full tool-call transcript. Keep it as a new tab over the same files,
  or switch on **To new workspace** to carry the current committed, staged,
  unstaged, and untracked-not-ignored code into a separate worktree.
- ✅ Diff vs the workspace's target branch (file list + colorized patch,
  including untracked files), with merge controls and **Continue** after a PR
  lands — the same workspace and chats move onto a fresh branch. Archived chats
  remain read-only and never show the action.
- ✅ **Launch and forward dev servers** — the workspace header's Play button
  starts Conductor's Run task directly when there is one choice. With multiple
  named `[scripts.run.<id>]` configs it opens a menu and asks which one to start
  every time—there is no remembered default. The relay then expands the
  repository's named `[[preview_urls]]` entries (including `$CONDUCTOR_PORT`) and
  exposes every local HTTP preview at its own tailnet-only HTTPS URL. The primary
  preview opens directly; additional previews appear in its dropdown. Preview
  paths, queries and fragments are preserved while only the loopback origin is
  replaced. Repositories without `preview_urls` use Conductor's exact Open-control
  destination when it is exposed to Accessibility, with detected-port fallback
  behavior for current Conductor builds.
  Open and Stop controls appear once it is running; Stop uses Conductor's own
  button and removes only this relay's Serve mappings. Forwarding a server that
  is already up presses nothing in Conductor, so it takes about a second and
  opens the tab from that same tap. This requires a Run task configured
  in Conductor and Tailscale on the viewing device, even when the relay itself
  uses public Funnel.
- ✅ **Send prompt** — two strategies:
  - **`applescript`** (default): drives Conductor's real UI send, landing in the
    *focused* session. Uses the session's own model/permission mode (zero risk of
    altering the agent). Bring the target workspace to front first.
  - **`sidecar`** (opt-in, `WRITE_STRATEGY=sidecar`): delivers straight to the
    target `sessionId` over Conductor's dispatch socket — precise per-workspace
    targeting, no focus needed. Speaks a private, versioned IPC (see FINDINGS ▸
    Writes), so it's the more fragile of the two.
- ✅ **Attach images and files** — tap the paperclip or paste an image into the
  composer. Files up to 25 MB are stored in Conductor's own attachment layout
  before the prompt is sent.
- ✅ **Cross-provider delegated roles** — configure picker-backed roles from the
  phone, then turn on **Workflow** beside the model picker in New workspace or an
  untouched **+ New chat**. The first message starts as the configured planning role
  and may call `delegate_task`, which opens a real sibling chat, attaches the parent
  transcript, applies the frozen model/effort/fast settings, and returns a Baton when
  the child is stably finished. Role chips and a live pipeline remain visible on the
  phone. Workflow roles are ordinary chats and never enable or depend on Conductor
  Plan mode.
- ✅ **Push notifications** when an agent finishes its turn or hits an error —
  see below.

## MCP: let your agents drive Conductor

`conductor-remote mcp` is an MCP server on stdio. It gives a coding agent the same
control the phone has, over the same relay.

Two transports, same 26 tools.

| | |
|---|---|
| `search_chats` · `read_chat` | full-text search every chat on this Mac, archived included, then read one |
| `list_workspaces` · `list_chats` · `workspace_diff` · `list_repos` | what is running, and what it changed |
| `plan_usage` | prompt-free Claude/Codex subscription allowances and reset times |
| `create_workspace` | start work in a repo, with an optional first prompt and model/effort/plan/fast choices, or `workflow: true` to use the configured planning root and authorize delegation without Plan mode. Creation uses a deep link; selected settings apply before the prompt |
| `dev_server` | inspect, start, forward or stop a workspace's configured Conductor Run task; use this instead of launching a long-lived server from an agent shell |
| `send_prompt` · `stop_turn` · `close_chat` | talk to a running agent, cancel its turn, or hide a chat tab |
| `split_chat` | move a tangent into a fresh tab, or set `new_workspace` to carry the transcript and current code into a separate worktree |
| `list_roles` · `set_role` | inspect or edit exact-picker delegated roles (model, effort, fast, and preamble; no Plan setting) |
| `delegate_task` · `list_delegations` · `dismiss_delegation` | run a task in a real sibling chat on another provider, observe its persisted queue, or dismiss a failed job |
| `list_models` · `set_agent_options` · `set_default_model` | cached model labels (including the starred default), model, effort, plan, fast; starring a default also selects it for the target chat, matching Conductor |
| `set_workspace_status` | move a workspace between the sidebar's status groups |
| `archive_workspace` | put a finished workspace away (Conductor's ⌘⇧A) — deletes the worktree, keeps the chat |
| `dismiss_prompt` | throw away a prompt the relay is still holding |
| `keep_awake` | hold this Mac awake with the lid shut, so a long run stays reachable |
| `relay_logs` | the relay's own log — why a send failed |

**Name it `conductor-remote`, not `conductor`.** Conductor injects an MCP server of its
own into every agent it runs, and that one is already called `conductor`. Register this
under the same name and inside a Conductor workspace the two collide: Conductor's tools
win, these 26 vanish, and the only trace left is this server's instructions text —
so it reads as if the tools should be there.

**stdio** — for an agent running on this Mac. The client spawns it as a child process;
there is no URL and nothing is exposed.

```bash
claude mcp add --scope user conductor-remote -- conductor-remote mcp
```

`--scope user` because a Conductor workspace is a fresh worktree each time, and a
project-scoped server registered against your main checkout does not reach it.

**HTTP** — for an agent that can only reach a URL, at `POST /mcp` on the relay, gated by
the same token as `/api/*`.

```bash
claude mcp add --transport http conductor-remote https://<your-magicdns>/mcp \
  --header "Authorization: Bearer $(cat ~/Library/Application\ Support/conductor-remote/token)"
```

Either way the relay must be running (`conductor-remote service status`). The stdio
server reads the persisted token itself, so it needs no configuration at all.

**Who can reach the HTTP endpoint depends on `EXPOSE`**, and this is the decision worth
making deliberately:

| `EXPOSE` | fronted by | who reaches `/mcp` |
|---|---|---|
| `tailnet` | `tailscale serve` | any device signed into your tailnet, from any network |
| `public` (default) | `tailscale funnel` | anyone on the internet holding the token |

`tailnet` is not LAN-only — a laptop on hotel wi-fi reaches it fine, over WireGuard. But
a *hosted* client is not on your tailnet: an agent running on someone else's servers
needs `public`, where the token is the only thing between the internet and
`create_workspace` / `send_prompt`. Prefer stdio when the agent is local, which is most
of the time.

| tool | what it does |
|---|---|
| `search_chats` | full-text search every chat on the Mac, archived included |
| `read_chat` | a transcript by `session_id` — works for archived workspaces |
| `list_workspaces` | what is running right now, with status and model |
| `list_chats` | the chat tabs in a workspace |
| `list_roles` | picker-backed cross-provider role definitions and validation issues |
| `set_role` | add or change one delegated role without touching Conductor's UI |
| `delegate_task` | enqueue a cross-provider sibling chat and return immediately with its job id |
| `list_delegations` | active and failed delegated jobs |
| `dismiss_delegation` | remove one failed job while retaining both chats and their role chips |
| `workspace_diff` | a workspace's diff against its target branch |
| `list_repos` | repos a workspace can be created in |
| `plan_usage` | Claude/Codex rolling subscription limits, without sending a prompt |
| `create_workspace` | start a new workspace, optionally with a first prompt and agent settings, or as a configured delegated workflow |
| `dev_server` | inspect/start/stop the configured Run task and its tailnet preview (`status` is read-only; start/stop drive the real UI) |
| `send_prompt` | send into an existing chat (drives the real UI) |
| `stop_turn` | cancel a running answer (drives the real UI) |
| `close_chat` | hide a chat tab without deleting its transcript (drives the real UI) |
| `set_workspace_status` | set the sidebar status (drives the real UI) |
| `archive_workspace` | archive a workspace (drives the real UI, deletes the worktree) |

Search, transcript, workspace/chat, diff, repo, role, delegation-status, dismiss,
dev-server status, keep-awake-status, and log reads touch no Conductor UI. `create_workspace` opens a
Conductor deep link, so creation itself needs no Accessibility and steals no focus;
requested model, effort, plan, and fast settings are applied later before the first
prompt. Its `workflow` option instead freezes the configured `planning` role, tags the
first chat as that role, and explicitly authorizes that root to use `delegate_task`;
it cannot be combined with explicit agent settings and never touches Plan mode. `delegate_task`
persists and returns immediately, then its background queue opens/configures/sends
through the same serialized UI path as phone writes. It never changes Plan mode.
Agents are explicitly told to use `dev_server` instead of starting a long-lived server
from their shell. Its start and stop actions go through Conductor's Run controls, which
preserves the workspace's allocated ports, run-mode policy and process-group cleanup;
the MCP tool cannot forbid shell commands, but removes the reason to use one here.

The HTTP transport is deliberately minimal: the server never initiates a message, so
there is no SSE stream and `GET /mcp` answers 405, which the spec allows. It keeps no
session either. A request carrying an `Origin` header is refused outright — a real MCP
client sends none and a browser cannot omit one, which closes the DNS-rebinding hole
without the relay having to know its own hostname behind Tailscale's TLS.

**Two agents cannot collide.** Conductor has one window, so every UI write in the
relay is serialized by a single process-local lock — which is exactly why these
tools call the relay instead of driving AppleScript themselves. Agents are marked
background priority, so they always yield to whoever is holding the phone, and past
four queued operations a caller is refused with "busy, retry shortly" rather than
joining a line it would only time out waiting in.

Worth knowing before you wire it up: `send_prompt` into a chat that is already
working **steers that agent** rather than starting a new turn, and `stop_turn`
destroys work in flight. `close_chat` keeps the transcript and is reversible with
Conductor's ⌘⇧T; a working chat is refused until `close_running` explicitly confirms
the desktop's own warning. The tool descriptions surface each of those choices.

The workflow icon in either workspace header opens **Roles**. Models there are
choices previously read from Conductor's real picker; a missing or ambiguous label
stays red and delegation is refused before the relay opens a tab. The shipped
`exploration` placeholder is intentionally invalid when several Spark rows exist,
so choose the exact one once. Accepted jobs keep a frozen copy of the role even if
you edit its definition later. In **New workspace** and the composer of an untouched
**+ New chat**, the **Workflow** pill beside the model picker is the kickoff switch:
while active, the planning role's settings are shown read-only and the generic Plan
control disappears. The first send creates or claims and tags the root before its
prompt is delivered. Its root instruction starts tracked sibling-chat delegation and
explicitly rules out provider-native Task/subagent machinery as well as Conductor Plan
mode. Once a chat has a first message or any delegated role, the kickoff pill is gone.

## Notifications

Turn them on from the **Connect sheet** (the QR button in the workspace list
header) ▸ *Notifications*. The relay then pings that phone whenever an agent
**ends a turn** — which covers finishing, asking you a question, and stopping at
a permission prompt — or **errors**. The notification carries the workspace name,
the repo, and the agent's last line; tapping it opens that workspace.

Notifications arrive with the app closed. There's a *Send a test notification*
link right under the switch to prove the path end to end.

**On iPhone/iPad you must add the app to your Home Screen first** — iOS only
exposes notifications to installed web apps, never to a Safari tab. The switch
says so if you haven't. The connection also has to be `https://` (the Tailscale
URL `yarn deploy` sets up, or `127.0.0.1` locally); a plain LAN IP is not a
secure context and browsers refuse push there.

Under the hood: standard Web Push (VAPID + `aes128gcm`), implemented directly on
`node:crypto` so the package keeps its zero runtime dependencies. Subscriptions
and the VAPID keypair live in
`~/Library/Application Support/conductor-remote/push.json` (mode `0600`). The
relay only ever POSTs to Apple's/Google's/Mozilla's push endpoint for the phones
you subscribed; nothing else leaves the Mac. `PUSH_NOTIFY=off` disables the whole
thing.

## Layout

```
src/       the Node relay: HTTP router, read-only SQLite reads, git diffs, the
           AppleScript/sidecar write path, both delivery queues, search, push,
           the MCP tools, and the keep-awake helper
web/       the React PWA (Vite root): app shell, components, hooks, api client
public/    icon.svg + PWA PNGs, at the repo root so Conductor's icon lookup
           finds them, plus the push and self-heal service-worker halves
scripts/   icon generation, the macOS LaunchAgent installer, the keep-awake
           setup, and the repository source validators
tests/     Vitest unit, contract, concurrency and integration tests
dist/      built PWA (gitignored) — what the relay serves
```

A per-file map, with what each one owns, is in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Security notes

- The relay binds to your Tailnet IP (or loopback), not `0.0.0.0`.
- All data endpoints require the shared token; static shell assets are public
  but carry no secrets. The service worker never caches `/api/*`.
- The write path can drive your real agents — keep the token private and the
  bind address off untrusted networks.
- The relay reads Conductor's SQLite DB **read-only** and never writes to it.
  Your Conductor data stays on your machine. Opening Models makes the already
  authenticated Claude/Codex CLI request its account-limit snapshot; it sends no
  prompt, transcript, or workspace data.

## Troubleshooting

### The phone can't reach a tailnet-only relay (Tailscale says Connected)

Suspect **iCloud Private Relay** first. It routes WebKit traffic — Safari, and any
home-screen web app — through Apple, around the VPN and its DNS, so MagicDNS never
answers. Turn it off in Settings ▸ Apple ID ▸ iCloud ▸ Private Relay.

It fails permanently rather than slowly, because `<node>.ts.net` keeps resolving
*publicly* to the Funnel ingress addresses long after Funnel is switched off (measured
unchanged 10+ minutes later, across three public resolvers), and those addresses answer
nothing once `serve` replaced `funnel`. A tailnet device gets the node's `100.x` address
from MagicDNS instead. So anything that bypasses MagicDNS lands on a dead address and
stays there. The same phone works fine on `--expose public`, where those ingress
addresses are live — which is what makes this look like the relay's fault.

To tell them apart from the Mac:

```bash
tailscale ping <phone-name>                        # is the tunnel actually up?
dig +short <node>.ts.net @1.1.1.1                  # public answer
dscacheutil -q host -a name <node>.ts.net          # MagicDNS answer
```

Different answers plus a phone that is on the tailnet means something on the phone is
resolving outside the VPN.

### Something failed and the Mac is somewhere else

The relay's own log is readable from the phone: **Connect sheet ▸ Relay logs**
(the QR button in the workspace header). It has three sources — `Live` is the
running relay's console, ordered and timestamped; `relay.log` / `relay.err.log`
tail the LaunchAgent's files on disk, which is where the output of a *previous*
process survives a crash-and-restart. **Problems only** filters to warnings and
errors, and **Copy** puts the visible lines on the clipboard for pasting into an
issue.

The same thing over HTTP (the access token is redacted from every response, so
what comes back is safe to share):

```bash
curl -s -H "authorization: Bearer $TOKEN" "$RELAY/api/logs?limit=100"                  # live
curl -s -H "authorization: Bearer $TOKEN" "$RELAY/api/logs?file=relay.err.log"         # on disk
```

On the Mac itself, `conductor-remote service logs` still follows both files.

### The relay stops answering when the Mac is on battery

**Symptom.** On battery, the phone loses the relay after a few minutes — even
though the LaunchAgent is still running and a keep-awake app (Amphetamine,
KeepingYouAwake, `caffeinate`) is active. Plug into power and it recovers. This
bites anyone running the relay on an unplugged laptop; it is **not** a bug in
conductor-remote.

**Cause — it's *Maintenance Sleep*, not idle sleep.** Confirm the reason:

```bash
pmset -g log | grep "Entering Sleep state due to" | tail
#  'Maintenance Sleep' / 'Sleep Service Back to Sleep'  ← the culprit
#  'Idle Sleep'                                          ← NOT what's happening
```

macOS has two independent sleep paths, and the popular keep-awake tools only
reach one of them:

| Layer | Sleep type | Controlled by | Keep-awake apps reach it? |
| --- | --- | --- | --- |
| Idle timer | `Idle Sleep` | `PreventUserIdleSystemSleep` power assertion | ✅ yes |
| Standby / Power Nap | **`Maintenance Sleep`** | `pmset` `standby` / `powernap` | ❌ **no** |

Amphetamine, KeepingYouAwake and `caffeinate -i` all hold only the *idle*
assertion. On battery the Mac isn't idle-sleeping — it's cycling through
**standby maintenance sleep** (a periodic dark-wake → back-to-sleep loop) that
lives at the root `pmset` layer no assertion can touch. Running those tools with
`sudo` changes nothing: the assertion is identical at any privilege, and there is
no assertion for the standby layer. Closing the lid is the same story one level
down: it sleeps an Apple Silicon Mac immediately and no assertion stops that
either, so a keep-awake app plus a shut lid is still a sleeping Mac. The root
`disablesleep` flag *does* hold it awake lid-closed, which is one lever `nosleep`
pulls below (in use on an M5 Pro). The other is a bounded `caffeinate -d` display
assertion. ScreenSaverDaemon checks it before starting the idle screen saver, so
the automatic screen lock stays off while the window runs. A manual lock or lid
close can still lock the session; sends then park until you unlock (#87).

**Fix — `conductor-remote nosleep`.** It blocks sleep at the root `pmset` layer (the
one no assertion reaches) for a bounded window and **auto-reverts** on exit, Ctrl-C, or
the timeout — nothing permanent, nothing left on your machine:

```bash
conductor-remote nosleep 2h     # also 90m, 30s, bare seconds; no arg = until Ctrl-C
```

The confirmation carries the wall-clock **expiry**, measured from when your password lands
rather than when you typed the command. It also warns that the automatic lock is off:

```text
✓ Sleep disabled until 21:45 (2h, incl. lid closed). Ctrl-C to restore.
⚠ Automatic screen lock is disabled for this window. Anyone with physical access can use this Mac.
```

This is on by default because the AppleScript write path needs an unlocked session. Configure
it from the Mac CLI. The value applies to terminal and phone-armed windows:

```bash
conductor-remote config set prevent-screen-lock off
conductor-remote config  # reports prevent-screen-lock off from the plist
```

Use `on` to restore the default. `PREVENT_SCREEN_LOCK=off` remains available as an
environment override for direct relay runs.

Out of the box it prompts for `sudo` and runs in the foreground. Since sending from the
phone already means manually turning on your hotspot, flipping this on for the session is
the same kind of deliberate, revertable switch — no boot daemon, no permanent change.
Simplest of all: keep the Mac on **AC power**, where it never maintenance-sleeps.

**Stop it asking — `conductor-remote nosleep setup`.** One-time, one password:

```bash
conductor-remote nosleep setup              # install
conductor-remote nosleep status             # what's installed, does it work, is sleep blocked now
conductor-remote nosleep setup --uninstall  # remove both files
```

It installs a root-owned helper at `/usr/local/libexec/conductor-remote-nosleep` and a
sudoers drop-in naming exactly that one command `NOPASSWD`. After it, `nosleep` needs no
password — which is also what would let the **relay** arm it, since the LaunchAgent has no
terminal to prompt on and so can never self-arm without this.

It is deliberately narrow, because a rule like this is the classic way a machine gets a
root hole. The helper lives in a directory only root can write (`/usr/local/bin` is
group-writable by `admin` on a stock Mac, so anything there would be trivially replaceable);
it is **copied out** of the package rather than referenced inside it, so the self-updater
can't smuggle new root-executed code in behind you (a stale copy is reported, never
silently refreshed); and the rule carries no argument wildcard — the helper validates its
own input. The drop-in is checked with `visudo -cf` as a draft and the assembled set is
re-checked after install, with the drop-in pulled back out if anything is wrong, since a
bad `/etc/sudoers.d` entry can cost you `sudo` altogether.

**From the phone.** Once the rule is installed, the Connect sheet grows a **Mac** section:
tap 1h / 4h / 8h / 16h to hold the Mac awake, or "Let it sleep" to end the window early
(`GET`/`POST`/`DELETE /api/nosleep`, capped at 16h). On screens narrower than 400px, the
4h button is hidden to keep the controls on one row. It reports whether the active
window blocks the screen lock. The armed window is spawned
*detached*, because the relay restarts itself on every self-update and a plain child would
die with it and quietly restore sleep at the worst moment; the relay finds it again after a
restart by reading `/var/run/conductor-remote-nosleep.pid`. Only one window may be armed —
arming takes over from any other, including one you left running in a terminal. That is not
politeness: two windows would each capture the *other's* already-flipped values and
"restore" those on the way out, leaving a Mac that can never sleep again.

Ending the window — "Let it sleep", or the timer running out — actually *sleeps* a
lid-closed Mac rather than just re-allowing sleep. Clamshell sleep is an event macOS fires
when the lid closes, and the lid closed while sleep was disabled, so restoring
`disablesleep 0` on its own leaves the Mac sitting awake under a shut lid indefinitely.
The relay checks the lid (`AppleClamshellState`) and runs `pmset sleepnow` — no root
needed — a beat after answering, so the phone gets its confirmation before the Mac drops
off the network. An open lid just gets sleep re-enabled, exactly as before.

The same section carries a **fallback network**: pick a Wi-Fi network the Mac already knows
(your phone's hotspot), and if the Mac loses its link entirely the funnel watchdog joins it
and re-registers Funnel, whose ingress a change of public endpoint invalidates anyway. It
stores **SSIDs only** — macOS holds the credentials, and passing a password to
`networksetup` would *write* one into the keychain. Off by default, behind a 5-minute
cooldown, and gated on `route -n get default` finding nothing: the associated SSID is not a
usable signal, since macOS hides it behind Location Services (this Mac reports "not
associated" while a default route is live on the same interface).

**Check / undo:**

```bash
pmset -g | grep -i sleepdisabled                    # 1 = sleep blocked
sudo pmset -b standby 1 powernap 1 disablesleep 0   # restore defaults
```

While `nosleep` is running you can quit any keep-awake app — those only ever asserted
on the idle layer, which was never the problem. It restores on its own; the manual undo
above is only for the rare case where it was killed hard.

## Disclaimer

Unofficial and not affiliated with, endorsed by, or supported by Conductor. It
reads your own local Conductor data and automates your own machine. It depends
on Conductor's on-disk layout (a SQLite DB + git worktrees) and, for the sidecar
write strategy, a private IPC — neither is a public API and both may change
between Conductor releases. See [FINDINGS.md](./FINDINGS.md) for how it's
structured to keep breakage rare and cheap to repair. macOS only.

## License

[MIT](./LICENSE)
