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

**Install flags.** `service install` takes flags for the install-time knobs (each
also settable via the env var in brackets — the flag wins when both are given).
Run `conductor-remote --help` for the full list. The common ones:

| Flag | Env | Purpose |
| --- | --- | --- |
| `--expose public\|tailnet` | `EXPOSE` | Reachability (public Funnel default, or tailnet-only) |
| `--port <n>` | `RELAY_PORT` | Listen port (default `8787`) |
| `--token <secret>` | `RELAY_TOKEN` | Pin the shared secret (default: generated + persisted) |
| `--write-strategy <s>` | `WRITE_STRATEGY` | `applescript` (default) or `sidecar` |

**Reachability (`--expose`).** By default the URL is exposed publicly via
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) — reachable from any
browser, gated by the embedded 128-bit token (so the phone needs **no** Tailscale
app). Funnel must be enabled once for your tailnet (Admin console). To keep it
tailnet-only instead (devices logged into your tailnet, via `tailscale serve`),
install with `--expose tailnet` (or `EXPOSE=tailnet`). The choice is remembered
across re-deploys.

## Architecture

```
 Phone PWA  ──HTTP/poll──►  Relay (Node, on the Mac, bound to Tailscale)
 (React, installable)                 │
                                      ├─ reads:  node:sqlite ⟶ conductor.db   (workspaces, sessions, transcripts)
                                      ├─ reads:  git ⟶ each worktree           (diffs vs target branch)
                                      └─ writes: Actuator ⟶ Conductor
                                                 ├─ applescript (default): osascript ⟶ focused session
                                                 └─ sidecar (opt-in):      unix socket ⟶ exact session
```

- **Two halves.** A **Node relay** on the Mac (reads Conductor's state, drives
  the write path) and a **React PWA** the phone installs. Vite builds the PWA to
  `dist/`, which the relay serves.
- **Reads are durable.** No Conductor API, no injection — the SQLite schema and
  git worktrees outlive UI changes.
- **Writes are the one fragile nerve** and are isolated behind a swappable
  `Actuator` (`src/writes.ts`).

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
`yarn dev` runs Vite (`:5173`, proxying `/api`) alongside the relay.

The relay prints a phone URL with an embedded token:

```
Open on your phone (same Tailnet):
  http://100.x.y.z:8787/#token=<generated>
```

Open that on the phone and **Add to Home Screen**. The token is stored in
`localStorage`; every `/api/*` call carries it, so other devices on the LAN
can't read your sessions.

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

| Var | Flag | Default | Purpose |
| --- | --- | --- | --- |
| `RELAY_PORT` | `--port` | `8787` | Listen port |
| `RELAY_HOST` | `--host` | auto (Tailscale `100.x`, else `127.0.0.1`) | Bind address |
| `RELAY_TOKEN` | `--token` | persisted (auto-generated, reused across restarts) | Override the shared secret |
| `WRITE_STRATEGY` | `--write-strategy` | `applescript` | `applescript` (focused session) or `sidecar` (precise per-session — see below) |
| `AUTO_UPDATE` | `--auto-update` | `auto` | Self-update mode: `auto` / `check` / `off` |
| `CONDUCTOR_DB` | `--db` | `~/Library/Application Support/com.conductor.app/conductor.db` | State DB |
| `CONDUCTOR_WORKSPACES` | `--workspaces` | `~/conductor/workspaces` | Worktree root |

The token is auto-generated once and persisted, so the home-screen icon keeps
working across restarts without any env var. To pin a specific secret (e.g. to
share a known URL), set `RELAY_TOKEN`:

```bash
RELAY_TOKEN=$(openssl rand -hex 16) yarn start
```

## What works today

- ✅ Live list of active workspaces with agent status (working / idle / done),
  repo, branch, model, context %, and an unread mark on any workspace whose chats
  finished something you haven't looked at — reading it *on the phone* clears it,
  which Conductor itself only does when you open the workspace on the Mac.
- ✅ Live transcript per session (assistant text, tool calls, queued messages),
  incremental polling.
- ✅ Diff vs the workspace's target branch (file list + colorized patch,
  including untracked files).
- ✅ **Send prompt** — two strategies:
  - **`applescript`** (default): drives Conductor's real UI send, landing in the
    *focused* session. Uses the session's own model/permission mode (zero risk of
    altering the agent). Bring the target workspace to front first.
  - **`sidecar`** (opt-in, `WRITE_STRATEGY=sidecar`): delivers straight to the
    target `sessionId` over Conductor's dispatch socket — precise per-workspace
    targeting, no focus needed. Speaks a private, versioned IPC (see FINDINGS ▸
    Writes), so it's the more fragile of the two.

## Layout

```
src/                the Node relay (no build step)
  server.ts         HTTP router: /api/* (token-gated) + static PWA
  config.ts         paths, port, Tailscale bind, token, write strategy
  db.ts             read-only node:sqlite handle to conductor.db
  reads.ts          workspaces / sessions / messages + worktree resolution
  transcript.ts     Claude Code SDK stream JSON → phone-renderable entries
  git.ts            workspace diff vs target branch (incl. untracked)
  sidecar.ts        Conductor sidecar IPC client (precise write path)
  writes.ts         Actuator interface + AppleScript (default) + Sidecar (opt-in)
  logbuf.ts         console capture + log-file tail behind /api/logs (token redacted)
web/                the React PWA (Vite)
  index.html, src/  app shell, components, hooks, api client
public/             icon.svg + PWA PNGs (repo-root so Conductor's icon lookup finds them)
scripts/
  dev.ts            runs Vite + relay together
  gen-icons.ts      rasterizes icon.svg → PWA PNGs (sharp)
  devtools-recon.js invoke-logger — only usable if a future build ships devtools
dist/               built PWA (gitignored) — what the relay serves
```

## Security notes

- The relay binds to your Tailnet IP (or loopback), not `0.0.0.0`.
- All data endpoints require the shared token; static shell assets are public
  but carry no secrets. The service worker never caches `/api/*`.
- The write path can drive your real agents — keep the token private and the
  bind address off untrusted networks.
- The relay reads Conductor's SQLite DB **read-only** and never writes to it.
  Your data stays on your machine — nothing is sent anywhere.

## Troubleshooting

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
no assertion for the standby layer. (Note: lid *closed* on Apple Silicon forces
sleep regardless — keep the lid open, or attach an external display **and** power.)

**Fix — `conductor-remote nosleep`.** It blocks sleep at the root `pmset` layer (the
one no assertion reaches) for a bounded window and **auto-reverts** on exit, Ctrl-C, or
the timeout — nothing permanent, nothing left on your machine:

```bash
conductor-remote nosleep 2h     # also 90m, 30s, bare seconds; no arg = until Ctrl-C
```

The confirmation carries the wall-clock **expiry**, measured from when your password lands
rather than when you typed the command — `✓ Sleep disabled until 21:45 (2h, incl. lid closed).`

It prompts for `sudo` once and runs in the foreground (the background LaunchAgent has no
terminal to prompt on, so it can't self-arm). Since sending from the phone already means
manually turning on your hotspot, flipping this on for the session is the same kind of
deliberate, revertable switch — no boot daemon, no permanent change. Simplest of all: keep
the Mac on **AC power**, where it never maintenance-sleeps.

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
