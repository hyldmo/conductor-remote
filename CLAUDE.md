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
- **Writes are the one fragile nerve.** Prompts go back via the `Actuator`
  interface (`src/writes.ts`), two strategies:
  - `applescript` (**default**): drives Conductor's real UI send, and is now
    **precise** — before pasting it focuses the target workspace via the command
    palette (Cmd+K → **branch name** → Enter), so the prompt lands in the right
    session regardless of what was focused. The branch is the palette's unique
    per-workspace key; a looser query can match a *command* (e.g. unarchive), so
    `writes.ts` always types `workspace.branch`. No private protocol, nothing to
    rebreak on a Conductor update. Timing-tuned AppleScript delays are load-bearing.
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
- **Yarn is standalone here.** Its own `yarn.lock` + `.yarnrc.yml`
  (`nodeLinker: node-modules`) makes this its own project despite a `package.json`
  higher up in `$HOME`. `package.json` pins `yarn@4` via `packageManager`, so
  contexts without a corepack shim (CI, a bare shell) must `corepack enable` first
  — see `.github/workflows/ci.yml`. The verify script is named `verify`, not `check`
  (collides with a Yarn Classic builtin).
- **If a Conductor update breaks a read**, re-derive from the DB schema; if it
  breaks the sidecar write, re-derive from `conductor-runtime`. Both procedures
  are in HANDOVER ▸ "Re-deriving Conductor internals."

## Conventions

- **Biome** formats and lints (`biome.jsonc`): tabs, single quotes, no semicolons,
  no trailing commas, 120 cols, arrow parens as-needed. Don't hand-format — run `yarn fix`.
- **TS strict**, `verbatimModuleSyntax` (use `import type`), `.ts`/`.tsx` extensions
  in imports are required (`allowImportingTsExtensions`).
- **Layout:** `src/` = Node relay (server, db, reads, git, transcript, sidecar,
  writes, config). `web/` = Vite-root React PWA (`web/src/`). `scripts/` = dev,
  icon-gen, service installer. `dist/` = build output (gitignored, relay-served).
- **Utility scripts** run under plain `node` (default type-stripping), stdlib-only —
  keep them strip-clean too (no param-property constructors/enums/namespaces).
- **Commit author** is the GitHub noreply address (privacy) — keep it for public commits.
