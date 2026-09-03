import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Workspace } from './reads.ts'
import { isLockedError, modelPickerLabel } from './shared.ts'
import { sidecarAvailable, sidecarSendUserMessage } from './sidecar.ts'

const exec = promisify(execFile)

/**
 * One UI operation at a time.
 *
 * Every script below drives Conductor's *shared, single* window — focus a
 * workspace, select a tab, write the composer — so two of them overlapping
 * interleaves their steps and lands a prompt in whatever the other one focused.
 * That is the exact failure the whole fail-closed AX design exists to prevent,
 * and no amount of per-step assertion catches it, because each script's reads
 * are true at the moment it makes them.
 *
 * It was unreachable while every write was one person tapping one button. It
 * stopped being unreachable when the relay grew a first-prompt queue that sends
 * on its own schedule (`firstprompt.ts`), so the queue can now fire while the
 * phone is mid-send.
 *
 * **"There is never a real queue of them" stopped being true** once `src/mcp.ts`
 * let agents drive this. A serialized queue was enough when the only two writers
 * were a person and a timer; with N agents the queue itself becomes the problem,
 * so three things go with the lock:
 *
 *  - **Depth is bounded.** Past `MAX_UI_QUEUE` a caller is refused immediately
 *    with `UiBusyError` instead of joining a line it cannot see. A write takes
 *    seconds against Conductor's real UI, so a deep queue guarantees the caller
 *    times out anyway — and "busy, try again" is a fact you can act on, while
 *    "took too long" is indistinguishable from a broken Conductor.
 *  - **The person wins.** The phone is `interactive`, agents and the delivery
 *    queues are `background`, and a background run never overtakes a waiting
 *    interactive one. Without this a burst of agent writes puts a human tap
 *    behind a minute of machine work on a lock they cannot see.
 *  - **Depth is readable** (`uiQueueDepth`), so a caller can say what it is
 *    waiting for rather than just hanging.
 *
 * Priority rides in an `AsyncLocalStorage` scope rather than a parameter: it is a
 * property of *who asked*, known only at the request boundary, and threading it
 * through every write signature would put it in eight places that don't care.
 */
export type UiPriority = 'interactive' | 'background'

/** Waiting runs past this are refused rather than queued. */
const MAX_UI_QUEUE = 4

const uiPriorityScope = new AsyncLocalStorage<UiPriority>()

/** Run `fn` with every UI operation it triggers marked at `priority`. */
export function withUiPriority<T>(priority: UiPriority, fn: () => Promise<T>): Promise<T> {
	return uiPriorityScope.run(priority, fn)
}

export class UiBusyError extends Error {
	readonly waiting: number
	constructor(waiting: number) {
		super(`Conductor's UI is busy — ${waiting} operation${waiting === 1 ? '' : 's'} already queued. Try again shortly.`)
		this.name = 'UiBusyError'
		this.waiting = waiting
	}
}

interface UiWaiter {
	/** 0 = interactive, 1 = background. Lower goes first. */
	rank: number
	seq: number
	start: () => void
}

let uiRunning = false
let uiSeq = 0
const uiWaiting: UiWaiter[] = []

/** What the UI lock is doing right now — `waiting` excludes the run in flight. */
export function uiQueueDepth(): { waiting: number; busy: boolean } {
	return { waiting: uiWaiting.length, busy: uiRunning }
}

function pumpUi(): void {
	if (uiRunning) return
	const next = uiWaiting.shift()
	if (!next) return
	uiRunning = true
	next.start()
}

/**
 * Take the lock, run `op`, release it. Exported for `tests/ui-lock.test.ts`,
 * which is the only way this queue's control flow gets read by anything.
 */
export function uiTurn<T>(op: () => Promise<T>): Promise<T> {
	const rank = uiPriorityScope.getStore() === 'background' ? 1 : 0
	if (uiWaiting.length >= MAX_UI_QUEUE) return Promise.reject(new UiBusyError(uiWaiting.length))
	return new Promise<T>((resolve, reject) => {
		const waiter: UiWaiter = {
			rank,
			seq: uiSeq++,
			start: () => {
				// A throw *before* the first await is still this run's failure, not a crash
				// that would leave the lock held forever.
				let settled: Promise<T>
				try {
					settled = op()
				} catch (err) {
					settled = Promise.reject(err)
				}
				// Release *before* resolving the caller, not after. Settling first and cleaning
				// up in a chained `.then` frees the lock one microtask late, so code that awaits
				// a write and then reads `uiQueueDepth()` is told a run is still in flight when
				// none is — and the next turn starts a tick later than it could.
				const release = () => {
					uiRunning = false
					pumpUi()
				}
				settled.then(
					value => {
						release()
						resolve(value)
					},
					err => {
						release()
						reject(err)
					}
				)
			}
		}
		// Stable insert: by rank, FIFO within a rank. A background run already started
		// keeps the lock — this decides who is next, never who is interrupted.
		const at = uiWaiting.findIndex(w => w.rank > rank)
		if (at < 0) uiWaiting.push(waiter)
		else uiWaiting.splice(at, 0, waiter)
		pumpUi()
	})
}

export interface SendResult {
	ok: boolean
	strategy: string
	warning?: string
	error?: string
}

export interface RunTaskResult {
	ok: boolean
	state?: 'running' | 'stopped'
	task?: string
	changed?: boolean
	ports?: number[]
	error?: string
}

/**
 * Where the target chat sits in Conductor's tab strip. `index` is 1-based in
 * `reads.listSessions` order (created_at ASC) — verified to match the strip's
 * left-to-right order — and `title` is the tab label used as a sanity check.
 */
export interface ChatTab {
	index: number
	count: number
	title: string
}

/** Who to deliver a prompt to. `sessionId` is the precise target; `workspace` carries the worktree + focus context. */
export interface SendTarget {
	workspace: Workspace
	sessionId: string | null
	/** Which chat tab to select once the workspace is focused. Omitted → whichever tab is already active. */
	tab?: ChatTab
}

/** How `/api/state` describes the write strategy in force (see `describeActuator`). */
export interface ActuatorInfo {
	name: string
	/** Human-readable note about this strategy's limits, surfaced in the UI. */
	caveat: string
	/** True when delivery is addressed to a specific session (no window-focus dependency). */
	precise: boolean
	/** False when the strategy's runtime check says it can't deliver right now. */
	available: boolean
}

/** How a submitted prompt behaves when its chat is already working. */
export interface PromptSendOptions {
	/** Queue the prompt behind the current turn instead of using the default follow-up behavior. */
	queue?: boolean
	/** Epoch ms when the caller stops waiting for this delivery attempt. */
	deadline?: number
}

export interface Actuator {
	readonly name: string
	/** Human-readable note about this strategy's limits, surfaced in the UI. */
	readonly caveat: string
	/** True when delivery is addressed to a specific session (no window-focus dependency). */
	readonly precise: boolean
	/**
	 * `deadline` is when the caller stops waiting, so a caller retrying
	 * inside one request bounds every attempt with the *same* number. A deadline
	 * rather than a duration because `uiTurn` may queue this run: only the run itself
	 * knows how much of the budget was still left when it finally started.
	 */
	send: (target: SendTarget, text: string, options?: PromptSendOptions) => Promise<SendResult>
	/** Runtime availability check (e.g. the sidecar socket must be reachable). */
	available?: () => Promise<boolean>
}

/**
 * How long one AppleScript run may take before it's killed.
 *
 * Sized from measurement, not taste. A send that *worked* measured 23.6s end to
 * end on a 30-workspace sidebar — past the 20s ceiling this replaces, which is why
 * ordinary sends were being killed mid-run and reported as "Conductor took too long
 * to respond". The cost is Accessibility round trips, not waiting: activating a
 * backgrounded Conductor and reading the pane cost ~10s cold, and finding the
 * sidebar row to press another ~10s.
 *
 * `openViaDeepLink` took the row scan out of the common path — a whole send now
 * measures ~4s, and focusing alone ~2s against the ~18s the same focus costs when
 * the link is unavailable — so this budget is really the *fallback's*, kept at the
 * size that fallback still needs. A ceiling costs nothing when a send is fast; only
 * a doomed one waits it out, and the caller's own deadline is what bounds that.
 */
export const SEND_ATTEMPT_MS = 28_000

/**
 * A restart's own ceiling. It is longer than a send's because it is mostly *waiting*:
 * up to 4s for the quit to be honoured, then a cold launch, then `waitForWindow(60)`'s
 * 15s for the first window — none of which can be hurried, and all of which the caller
 * would rather wait through than be told "try again" about.
 */
export const RESTART_ATTEMPT_MS = 45_000

/**
 * A run's own ceiling, taken off the caller's deadline at the moment it actually
 * starts.
 *
 * Both halves matter. `uiTurn` above means a run can sit in the queue behind
 * another write, so a duration computed when it was *requested* would let a queued
 * run overshoot a deadline the caller is still holding a phone open on.
 * `SEND_ATTEMPT_MS` then caps it, because a caller with a minute of budget still
 * shouldn't spend all of it on one doomed run when a retry is the thing that works.
 * The floor keeps a squeezed run honest instead of passing `timeout: 0`, which node
 * reads as "no timeout at all".
 */
function runCeiling(deadline: number): number {
	return Math.max(5_000, Math.min(SEND_ATTEMPT_MS, deadline - Date.now()))
}

/**
 * Failures no amount of retrying will fix, so a caller that retries can stop at
 * once instead of spending a whole budget to arrive at the same sentence.
 *
 * Matched on phrases this file writes itself — the first two from `refusalReason`,
 * the rest from the target checks below — never on macOS's own wording, which we
 * quote verbatim precisely because it drifts. The refusals are the ones a node
 * upgrade causes by silently revoking Accessibility: they fail instantly and
 * identically every time, so making the phone sit through a whole retry budget to
 * be told a permission is missing is worse than being told at once. The rest are
 * malformed targets — no session, no branch — which no attempt can turn into one.
 */
const TERMINAL_ERRORS = [
	'not trusted for Accessibility',
	'blocked the relay from controlling the UI',
	'no session id to target',
	'workspace has no branch to focus'
]

export function retryWontHelp(error: string | undefined): boolean {
	return error !== undefined && TERMINAL_ERRORS.some(phrase => error.includes(phrase))
}

/**
 * A send that failed because the Mac's screen is locked. Deliberately *not* in
 * `TERMINAL_ERRORS`: it isn't terminal (an unlock fixes it) but it also isn't a
 * warm-up cost a retry loop should burn budget on — the caller parks the prompt
 * instead (src/parked.ts) and the queue delivers it when the lock lifts. Matched
 * on the phrase every lock refusal in conductor.applescript starts with; the
 * words are ours, so they can't drift under us the way macOS's can. The phrase
 * itself lives in src/shared.ts because the phone matches it too — it is what
 * puts the Screen Sharing link beside a refusal nobody else can clear.
 */
export function lockBlocked(error: string | undefined): boolean {
	return isLockedError(error)
}

/**
 * A run that ended with the prompt still sitting in Conductor's composer
 * (`submitComposer`). The draft was never consumed, so this run wrote no row and
 * the caller's confirm window has nothing to wait for — six seconds spent watching
 * for something the run already proved didn't happen. Only the *waiting* is
 * skipped: an earlier attempt's row can still be arriving, so the caller checks
 * once before typing again.
 *
 * Matched on the phrase the send script writes itself, like `lockBlocked` above,
 * so macOS wording can't drift under it.
 */
export function sendNeverStarted(error: string | undefined): boolean {
	return (error ?? '').includes('still sitting in its composer')
}

/**
 * Node's own read of the lock screen — the same CGSessionCopyCurrentDictionary
 * probe `screenLocked()` in conductor.applescript makes, minus the AppleScript
 * wrapper, so the parked-prompt queue can poll it without spinning up a whole
 * UI script (and without needing Accessibility at all). `null` means the probe
 * itself failed — callers should treat that as "try the send and let it tell
 * you", not as either lock state.
 */
export async function screenLocked(): Promise<boolean | null> {
	// Keep in lockstep with `screenLocked()` in conductor.applescript, traps and
	// all: $.CFBridgingRelease segfaults under JXA, and without the bindFunction
	// rebind deepUnwrap reads the CF dictionary as undefined — a silent "unlocked"
	// on a locked Mac.
	const jxa =
		"ObjC.import('CoreGraphics'); ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]); const d = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()) || {}; d.CGSSessionScreenIsLocked ? 'locked' : 'unlocked'"
	try {
		const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 5_000 })
		const out = stdout.trim()
		if (out === 'locked') return true
		if (out === 'unlocked') return false
		return null
	} catch {
		return null
	}
}

/**
 * The sidecar IPC path — the precise, per-session write. Delivers straight to
 * `sessionId` over Conductor's own dispatch socket (see sidecar.ts), so it needs
 * no window focus and the app UI reflects the turn correctly.
 *
 * Opt-in (WRITE_STRATEGY=sidecar) because it speaks a private, versioned IPC and
 * hasn't been validated by an automated live send (that would inject a prompt
 * into a running agent). It is the intended default once you've confirmed it on
 * your setup.
 */
export class SidecarActuator implements Actuator {
	readonly name = 'sidecar'
	readonly caveat =
		'Delivered straight to the target session over Conductor’s dispatch socket — precise per-workspace targeting.'
	readonly precise = true

	available(): Promise<boolean> {
		return sidecarAvailable()
	}

	/** `deadline` is ignored — the sidecar is one socket write, with no UI to wait on. */
	async send(target: SendTarget, text: string, options: PromptSendOptions = {}): Promise<SendResult> {
		const sessionId = target.sessionId ?? target.workspace.active_session_id
		if (!sessionId) return { ok: false, strategy: this.name, error: 'no session id to target' }
		try {
			await sidecarSendUserMessage(sessionId, text, options.queue ? 'queue' : 'default')
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: err instanceof Error ? err.message : String(err) }
		}
	}
}

/**
 * Every AppleScript handler the write path uses, read from src/conductor.applescript.
 *
 * A sibling asset, so it resolves off this module's own directory rather than
 * `packageRoot()`. The usual rule here (never anchor on `import.meta.dirname/..`) exists
 * because the compiled files sit one level deeper in the tarball, which is exactly
 * why a *sibling* is the one thing that may anchor there: `yarn build:node` copies the
 * script next to the emitted JS, so the same join resolves unbuilt and installed.
 * Read once at import, because a missing copy is a packaging bug and a relay that
 * refuses to boot with an ENOENT naming the path is the loudest way to say so.
 */
const CONDUCTOR_HANDLERS = readFileSync(path.join(import.meta.dirname, 'conductor.applescript'), 'utf8').trimEnd()

/**
 * The URL scheme Conductor registers, which is per *release channel*: the
 * production build answers `conductor://`, the pre-release ones
 * `conductor-alpha://`, `conductor-beta://`, `conductor-dev://` and friends.
 * Everything else in this file addresses `application "Conductor"` by name, so
 * production is the only channel the write path works against anyway — the
 * override exists so a channel build needs a variable rather than a patch.
 */
const CONDUCTOR_SCHEME = process.env.RELAY_CONDUCTOR_SCHEME || 'conductor'

/**
 * Conductor's own link to a workspace, and optionally to one chat inside it —
 * exactly what its sidebar row menu copies under "Copy link" (Cmd+Shift+C).
 *
 * `conductor://workspace?id=<workspace>&session=<chat>` is the shape that works,
 * and the near misses all fail *badly*, so this is the one place that builds it:
 * the parameters sit behind a real `?` (unlike the create-workspace links, which
 * are flat after the scheme), the workspace id is `id` rather than `workspace`,
 * and `workspace` must be the URL's **host** — `conductor:///workspace/<id>`,
 * with the id in the path, falls through to the flat-parameter parser and
 * **creates a new workspace in the first repo**. A path-shaped link with the
 * right host (`conductor://workspace/<id>`) is merely ignored.
 *
 * `session` is optional and names a chat by `sessions.id`, the same id the relay
 * already serves; omitted, Conductor opens whichever tab that workspace had.
 * A hidden chat (`sessions.is_hidden`) has no tab, and Conductor keeps the
 * workspace's current one rather than reporting anything, so the caller's own
 * tab assertion is still what catches it.
 *
 * The https form Conductor copies for sharing —
 * `https://app.conductor.build/workspace/<id>?session=<chat>` — reaches the same
 * handler, but only once macOS has decided to hand it to the app; the desktop
 * build declares no associated domain, so a browser gets it first. Locally the
 * scheme form is the one that always lands.
 */
function workspaceLink(workspaceId: string, sessionId: string | null): string {
	const params = new URLSearchParams({ id: workspaceId })
	if (sessionId) params.set('session', sessionId)
	return `${CONDUCTOR_SCHEME}://workspace?${params.toString()}`
}

/** Conductor's command palette matches workspaces by branch — its unique key. A
 * looser query (directory name) can match a command like unarchive, so prefer
 * branch and only fall back when it's absent. */
function focusQuery(ws: Workspace): string {
	return ws.branch || ws.workspace_name || ws.directory_name || ''
}

/**
 * Every title Conductor might be showing for this workspace in the sidebar
 * (its precedence: manual name → PR title → humanized branch → codename). The
 * sidebar press tries each and requires a unique row; a miss just means we fall
 * back to the palette, so this doesn't have to reproduce the precedence exactly.
 */
function sidebarTitles(ws: Workspace): string[] {
	const slug = ws.branch?.includes('/') ? ws.branch.slice(ws.branch.indexOf('/') + 1) : ws.branch
	const humanized = slug?.replace(/[-_]/g, ' ').trim()
	return [
		ws.workspace_name,
		ws.pr_title,
		humanized ? humanized[0].toUpperCase() + humanized.slice(1) : '',
		ws.directory_name
	].filter((t): t is string => Boolean(t))
}

/**
 * May the actuator restart Conductor to force a window into existence?
 *
 * Restarting is the only lever left when a running, windowless Conductor ignores
 * both `reopen` and a Dock click — it is single-window and single-instance, so
 * there is nothing else to press. It is also the one step here that can destroy
 * work: quitting takes any agent mid-turn down with it. "Nothing is running" is a
 * fact only the read side has, so server.ts wires this to a DB read rather than
 * writes.ts guessing. Unset → never restart, which is the safe default for any
 * caller that hasn't opted in.
 */
let restartGuard: (() => boolean) | null = null

export function setRestartGuard(guard: (() => boolean) | null): void {
	restartGuard = guard
}

function restartAllowed(): boolean {
	try {
		return restartGuard?.() ?? false
	} catch {
		return false
	}
}

/** Fixed targeting values travel in the environment; the three UI labels ride in RELAY_TARGET_FILE. */
function targetEnv(target: SendTarget): Record<string, string> {
	return {
		RELAY_ALLOW_RESTART: restartAllowed() ? '1' : '',
		RELAY_TAB_INDEX: String(target.tab?.index ?? 0),
		RELAY_TAB_COUNT: String(target.tab?.count ?? 0),
		RELAY_WS_BRANCH: target.workspace.branch ?? '',
		RELAY_WS_REPO: target.workspace.repo_name ?? '',
		RELAY_WS_LINK: workspaceLink(target.workspace.id, target.sessionId)
	}
}

/**
 * The target file is line-based: tab title, palette query, then sidebar-title candidates. Conductor labels
 * cannot contain a newline, and `do shell script` reads this file as UTF-8 rather than MacRoman.
 */
function targetLines(target: SendTarget): string[] {
	return [target.tab?.title ?? '', focusQuery(target.workspace), ...sidebarTitles(target.workspace)]
}

/**
 * Give one UI action the three matching labels in a UTF-8 file. `system attribute` decodes text as MacRoman,
 * but it safely carries the temporary file path.
 */
export async function withTargetEnvironment<T>(
	target: SendTarget,
	action: (environment: Record<string, string>) => Promise<T>
): Promise<T> {
	const fs = await import('node:fs/promises')
	const os = await import('node:os')
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-target-'))
	const file = path.join(directory, 'text')
	try {
		await fs.writeFile(file, targetLines(target).join('\n'), 'utf8')
		return await action({ ...targetEnv(target), RELAY_TARGET_FILE: file })
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
	}
}

/** osascript echoes the whole failing script back; keep just the reason for the phone. */
function osaError(err: unknown, timeoutMsg = 'Conductor took too long to respond'): string {
	const raw = err instanceof Error ? err.message : String(err)
	// A timeout kill carries no execution error at all — its first line is
	// "Command failed: osascript -e" plus the whole script, which is useless here.
	if (err && typeof err === 'object' && 'killed' in err && (err as { killed?: boolean }).killed) {
		return timeoutMsg
	}
	return raw.match(/execution error: (.+?) \(-?\d+\)/)?.[1] ?? raw.split('\n')[0]
}

/**
 * Drives Conductor's real send path via macOS Accessibility (AppleScript): focus
 * the target workspace, paste the prompt, press Enter. Uses whatever model /
 * permission mode the session already has (zero risk of altering the agent),
 * which is why it's the default.
 *
 * Precise targeting comes from opening Conductor's own workspace link first
 * (`conductor://workspace?id=…&session=…`, see `workspaceLink`) and then
 * confirming the pane and the chat tab through Accessibility (see
 * src/conductor.applescript), so the prompt lands in the right session regardless
 * of what was focused. The link is public and id-addressed; the AX reads only
 * check it, and pressing the sidebar row or the command palette remains the
 * fallback for a Conductor that doesn't answer it.
 */
export class AppleScriptActuator implements Actuator {
	readonly name = 'applescript'
	readonly caveat = "Opens the target workspace's own Conductor link, then confirms the chat tab before sending."
	readonly precise = true

	async send(target: SendTarget, text: string, options: PromptSendOptions = {}): Promise<SendResult> {
		const deadline = options.deadline ?? Date.now() + SEND_ATTEMPT_MS
		// Open the target workspace's own link, confirm its chat tab, fill the composer, send.
		// Filling is an Accessibility write (no keystrokes, no clipboard); the
		// clipboard paste is kept only as a fallback, and stashes/restores around it.
		//
		// The send is then read back rather than assumed (`submitComposer`): Conductor
		// consumes the draft when it takes a prompt, so a composer that still holds the
		// text is an Enter that went nowhere, and pressing again inside this run costs
		// under a second. Left to `deliverPrompt` the same failure costs the 6s confirm
		// window plus a whole second run, which is the ~10s of prompt-sitting-on-screen
		// this Mac's logs recorded. A composer that survives three presses is stuck on
		// something the script can't see, so it errors and lets that retry take over.
		const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
set promptText to my normalizeNewlines(do shell script "cat" & " " & quoted form of (system attribute "RELAY_PROMPT_FILE"))
set textBox to my composerField()
if not (my fillComposer(textBox, promptText)) then
	set savedClipboard to the clipboard
	my pasteComposer()
	delay 0.1
	set the clipboard to savedClipboard
end if
set presses to my submitComposer(textBox, promptText, (system attribute "RELAY_QUEUE_PROMPT") is "1")
if presses is 0 then error "Conductor ignored Enter - the prompt is still sitting in its composer"
return "presses:" & presses
`.trim()
		// Pass the prompt via a temp file + env to avoid AppleScript string escaping.
		const os = await import('node:os')
		const fs = await import('node:fs/promises')
		const path = await import('node:path')
		const tmp = path.join(os.tmpdir(), `relay-prompt-${process.pid}-${Date.now()}.txt`)
		await fs.writeFile(tmp, text, 'utf8')
		try {
			const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
				uiTurn(() =>
					exec('osascript', ['-e', script], {
						env: {
							...process.env,
							RELAY_PROMPT_FILE: tmp,
							RELAY_QUEUE_PROMPT: options.queue ? '1' : '',
							...targetEnvironment
						},
						timeout: runCeiling(deadline)
					})
				)
			)
			// A rescued send is otherwise indistinguishable from one that worked first
			// time, so the failure would leave the log whether it was fixed or hidden.
			const presses = Number(stdout.match(/presses:(\d+)/)?.[1] ?? 1)
			if (presses > 1) {
				console.warn(`[relay] Conductor ignored Enter — the composer cleared on press ${presses}`)
			}
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: osaError(err) }
		} finally {
			await fs.rm(tmp, { force: true }).catch(() => undefined)
		}
	}
}

/**
 * Stop the answer a chat is streaming — the desktop app's stop button, reached
 * through the same focus-and-assert path as a send and then Conductor's own
 * "Cancel agent" shortcut (see `cancelAgent` in conductor.applescript for why a
 * keystroke rather than the button).
 *
 * The branch is required rather than optional. Everywhere else a workspace with
 * no branch merely loses the pane assertion; here that assertion is the only thing
 * standing between "stop this agent" and "throw away a different agent's turn", so
 * a target that can't be checked is refused instead of aimed.
 *
 * Nothing is confirmed here: `sessions.status` leaving `working` is the receipt and
 * server.ts waits for it, the same way agent settings are confirmed against the DB
 * rather than against the UI that was just driven.
 */
export async function stopTurn(target: SendTarget): Promise<SendResult> {
	if (!target.workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my cancelAgent()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Hide one chat through Conductor's own Close tab action (Command-W).
 *
 * Like `stopTurn`, the branch is required because Command-W acts on whatever has
 * keyboard focus. `selectChatTab` proves the target and `closeChatTab` moves focus
 * back out of the terminal before pressing it. Closing is reversible in Conductor,
 * but a running chat still gets its desktop confirmation: `closeRunning` is the
 * caller's explicit answer to that prompt, never something this layer infers.
 *
 * The script only reports that it pressed the action. `sessions.is_hidden` is the
 * receipt; server.ts waits until `Reads.listSessions` no longer returns this id.
 */
export async function closeChat(target: SendTarget, closeRunning: boolean): Promise<SendResult> {
	if (!target.workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my closeChatTab()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_CLOSE_RUNNING: closeRunning ? '1' : ''
					},
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Press the Wi-Fi menu's row for a personal hotspot — Instant Hotspot, the same
 * button a human clicks. `networksetup` can only join a network that is
 * broadcasting, and a personal hotspot usually isn't; the row in Control
 * Center's Wi-Fi popover is fed by Continuity over Bluetooth, and pressing it
 * asks the phone to wake its hotspot. The funnel watchdog reaches for this when
 * a plain join answered "Could not find network".
 *
 * The one UI write here that doesn't target Conductor, and it still takes a
 * uiTurn: the popover steals key focus, so a palette fallback running at the
 * same moment would type into it. The name travels via a temp file like the
 * prompt does — same escaping-and-encoding dodge, and hotspot names ("Han
 * høyes iPhone") are non-ASCII more often than prompts are. Success here means
 * *pressed*, nothing more: joining takes several seconds of Bluetooth wake +
 * DHCP, so the caller owns the wait, and it watches `hasDefaultRoute()` — the
 * one link signal that needs no permission — not this function's word.
 * Everything else — the lock check, the toggle-aware close, the already-open
 * abort, the contention story — lives with the handler in conductor.applescript.
 */
export async function joinInstantHotspot(name: string): Promise<{ ok: boolean; error?: string }> {
	const script = `
${CONDUCTOR_HANDLERS}

my joinInstantHotspot()`.trim()
	const os = await import('node:os')
	const fs = await import('node:fs/promises')
	const tmp = path.join(os.tmpdir(), `relay-hotspot-${process.pid}-${Date.now()}.txt`)
	await fs.writeFile(tmp, name, 'utf8')
	try {
		await uiTurn(() =>
			exec('osascript', ['-e', script], {
				env: { ...process.env, RELAY_HOTSPOT_FILE: tmp },
				timeout: 25_000
			})
		)
		return { ok: true }
	} catch (err) {
		return { ok: false, error: osaError(err, 'the Wi-Fi menu press took too long') }
	} finally {
		await fs.rm(tmp, { force: true }).catch(() => undefined)
	}
}

/**
 * Conductor stores the effort level in a provider-specific session column
 * (`codex_thinking_level` or `claude_effort_level`), normalized by Reads onto the
 * relay's stable wire field. The composer button is labelled with the human name
 * and *cycles* through these values, so both directions are needed: the label to
 * press toward, and the normalized DB value to confirm against.
 */
export const EFFORT_LABELS: Record<string, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultracode: 'Ultracode'
}

/** What a phone can change about the agent before (or instead of) sending a prompt. */
export interface AgentOptions {
	/** A normalized effort value (low…ultracode), not the UI label. */
	effort?: string
	plan?: boolean
	/** Fast mode exposes no readable state, so pass `true` only when it must flip. */
	toggleFast?: boolean
	/** The model picker's menu label, e.g. "Opus 5" or "Sonnet 4.6". */
	model?: string
}

/**
 * A boolean patch says what state the caller wants, not that the matching UI
 * control must be pressed. Avoid looking for Plan when Conductor already records
 * the requested mode — some models do not render that control at all when it is
 * off. Unknown state remains fail-closed and is sent through to the actuator.
 */
export function planSettingForUi(
	wanted: boolean | undefined,
	currentPermissionMode: string | null | undefined
): boolean | undefined {
	if (wanted === undefined) return undefined
	return currentPermissionMode === (wanted ? 'plan' : 'default') ? undefined : wanted
}

/**
 * Apply agent settings to a specific chat: focus its workspace and tab (same
 * verified path as a send), then drive the composer's own controls. Every step
 * confirms the control landed on the requested value and errors out otherwise,
 * so a half-applied change is reported rather than assumed.
 */
export async function setAgentOptions(target: SendTarget, opts: AgentOptions): Promise<SendResult> {
	if (opts.effort && !EFFORT_LABELS[opts.effort]) {
		return { ok: false, strategy: 'applescript', error: `unknown effort level ${opts.effort}` }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my applyAgentOptions()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_SET_EFFORT: opts.effort ? EFFORT_LABELS[opts.effort] : '',
						RELAY_SET_PLAN: opts.plan === undefined ? '' : opts.plan ? '1' : '0',
						RELAY_SET_FAST: opts.toggleFast ? '1' : '',
						RELAY_SET_MODEL: opts.model ?? ''
					},
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

export interface DefaultModelResult extends SendResult {
	/** The exact picker label Conductor starred (temporary NEW badge removed). */
	model?: string
}

/**
 * Star one picker row as Conductor's user-wide default model.
 *
 * The desktop exposes this as a child button named "Set … as default and select",
 * so this deliberately has both effects: it changes the global default and selects
 * that model for `target`. The AppleScript reopens the picker and reads the unique
 * starred row back before this reports success.
 */
export async function setDefaultModel(target: SendTarget, model: string): Promise<DefaultModelResult> {
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
return my setDefaultModel(system attribute "RELAY_DEFAULT_MODEL")`.trim()
	try {
		const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment, RELAY_DEFAULT_MODEL: model },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		const selected = modelPickerLabel(stdout.trim())
		if (!selected) return { ok: false, strategy: 'applescript', error: 'Conductor returned no default model' }
		return { ok: true, strategy: 'applescript', model: selected }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Put a workspace away — Conductor's own "Archive workspace" (Command-Shift-A),
 * pressed on the workspace this run has just focused and asserted.
 *
 * The chord acts on whatever the pane is showing, so the assertion is the entire
 * guard and the branch is required rather than optional, exactly as it is for
 * `stopTurn`. The damage is worse here than a mis-aimed prompt: archiving deletes
 * the worktree and takes any agent mid-turn down with it, so a workspace whose pane
 * cannot be checked is refused instead of guessed at.
 *
 * `stopAgents` is what the caller has said about that second half. Conductor draws a
 * confirmation ("Stop agents and archive") when the workspace still has an agent
 * working, and the script presses it only with this set; without it the dialog is
 * dismissed and the run fails, so a tap that meant "archive" can never quietly end
 * someone else's turn. An idle workspace draws no dialog at all.
 *
 * Nothing is confirmed here. `workspaces.state` becoming `archived` is the receipt
 * and server.ts waits for it, the same way the stop and the status change do.
 */
export async function archiveWorkspace(workspace: Workspace, stopAgents: boolean): Promise<SendResult> {
	if (!workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my archiveWorkspace()
return "ok"`.trim()
	try {
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment, RELAY_ARCHIVE_AGENTS: stopAgents ? '1' : '' },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Quit Conductor and start it again because the phone asked — the one write here
 * whose subject is the app rather than anything inside it.
 *
 * The lever already existed and was unreachable. `activateConductor` restarts as its
 * last resort, but only after a *running* Conductor has drawn no window through
 * `reopen` and a Dock click, so it answers exactly one failure: a windowless app. The
 * failure this is for looks healthy from every probe on that ladder — window up,
 * sidebar drawing, composer taking prompts — while the agent runtime behind it has
 * stopped producing anything. Measured on this Mac (2026-09-02): the last agent frame
 * in `session_messages` was 20:47:44 and prompts kept landing as user rows for the
 * next two and a half hours, each turn flipping `working → idle` having written
 * nothing. Nothing on the read side can fix that, and "quit it on your Mac" is not
 * advice a phone can act on.
 *
 * Two gates, and neither lives here. The **working chats** are counted from the DB by
 * server.ts, which refuses without `stopAgents` — quitting takes every agent mid-turn
 * down with it, so that has to be said out loud, exactly as it is for archiving. The
 * **lock screen** is asked by `restartApp` itself, because a relaunch fired behind it
 * comes up windowless (and once, wedged). What is left for this function is the UI
 * lock: a restart is not a read, and letting one land while a send is mid-flight would
 * quit the app between the composer write and the Enter.
 */
export async function restartConductorApp(): Promise<SendResult> {
	const script = `
${CONDUCTOR_HANDLERS}

return my restartApp()`.trim()
	try {
		await uiTurn(() => exec('osascript', ['-e', script], { env: { ...process.env }, timeout: RESTART_ATTEMPT_MS }))
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err, 'Conductor didn’t come back in time') }
	}
}

/**
 * The workspace statuses Conductor's sidebar groups by, mapped from the value it
 * stores in `workspaces.manual_status` to the label on its own menu. `canceled`
 * is on the menu but has never been written in this DB, so it's the one spelling
 * here that is taken from the UI rather than confirmed against stored data — a
 * mismatch surfaces as a failed confirmation naming what Conductor actually wrote.
 */
export const WORKSPACE_STATUS_LABELS: Record<string, string> = {
	backlog: 'Backlog',
	'in-progress': 'In progress',
	'in-review': 'In review',
	done: 'Done',
	canceled: 'Canceled'
}

/**
 * Move a workspace between the sidebar's status groups — the thing a merged PR
 * that Conductor never linked can't do for itself.
 *
 * Unlike every other write here this one never changes what's on screen: it
 * right-clicks the workspace's *row* (AXShowMenu) and works the menu, so the
 * workspace you were reading stays open. It does need the row to be rendered, and
 * a collapsed sidebar section renders none — so the script opens the folded
 * sections itself, looks again, and folds back exactly the ones it opened. That
 * costs a second sidebar scan, which is affordable only because that scan reads
 * every row's name in two Apple events rather than one per row (15s → ~1s on a
 * 50-workspace sidebar; see findSidebarRow). Measured end to end on 2026-09-01:
 * 8.2s through a folded section, 5.4s through an open one. The budget is 35s
 * anyway, because sidebarRowsAndNames falls back to the per-row reads when the
 * list no longer matches its shape, and that path pays the old 15s twice.
 */
export async function setWorkspaceStatus(workspace: Workspace, status: string): Promise<SendResult> {
	const label = WORKSPACE_STATUS_LABELS[status]
	if (!label) return { ok: false, strategy: 'applescript', error: `unknown status ${status}` }
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my setWorkspaceStatus()
return "ok"`.trim()
	try {
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_SET_STATUS: label
					},
					timeout: 35000
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

export interface ModelMenuResult {
	ok: boolean
	models?: string[]
	/** The picker row whose star is selected. */
	defaultModel?: string
	error?: string
}

const DEFAULT_MODEL_LINE = '__CONDUCTOR_DEFAULT_MODEL__\t'

/** Turn listModels' tagged line protocol into the live picker state. Exported for its parser tests. */
export function parseModelMenuOutput(stdout: string): Pick<ModelMenuResult, 'models' | 'defaultModel'> {
	let defaultModel: string | undefined
	const models: string[] = []
	for (const raw of stdout.split('\n')) {
		const line = raw.trim()
		if (!line) continue
		if (line.startsWith(DEFAULT_MODEL_LINE)) {
			defaultModel = modelPickerLabel(line.slice(DEFAULT_MODEL_LINE.length).trim()) || undefined
			continue
		}
		models.push(modelPickerLabel(line))
	}
	return { models: [...new Set(models.filter(Boolean))], defaultModel }
}

/** The model labels Conductor is currently offering, plus its starred default. */
export async function listAgentModels(target: SendTarget): Promise<ModelMenuResult> {
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
return my listModels()`.trim()
	try {
		const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, ...parseModelMenuOutput(stdout) }
	} catch (err) {
		return { ok: false, error: osaError(err) }
	}
}

/**
 * Create a *new workspace*, optionally with a first prompt, via Conductor's
 * deep-link scheme (conductor.build/docs/reference/deep-links).
 *
 * This is the one write here that touches no UI at all: no Accessibility, no
 * keystrokes, no focus dependency — macOS hands the URL to Conductor and it
 * creates the worktree. Nothing to rebreak on an update, unlike every other
 * path in this file.
 *
 * Three things the scheme dictates:
 *  - Parameters sit *flat* after the scheme (`conductor://prompt=…&path=…`), not
 *    behind a `?`, and every value must be URL-encoded — which is also what stops
 *    a prompt containing `&path=` from redirecting the workspace to another repo.
 *  - **An unmatched (or absent) `path` silently falls back to the first repo**, so
 *    the caller resolves a real `root_path` first rather than trusting a name.
 *  - **`prompt` is optional**: a bare `conductor://path=…` opens an empty
 *    workspace, same as Conductor's own New workspace. That form isn't in the
 *    docs (every documented route carries a prompt) but is verified against the
 *    live app — so if it ever stops working, this is the line to suspect.
 *
 * The link is fire-and-forget: it reports that Conductor was *handed* the URL,
 * never that a workspace appeared. The caller watches the DB for that.
 */
export async function createWorkspace(prompt: string, repoPath: string | null): Promise<SendResult> {
	if (!prompt.trim() && !repoPath) {
		return { ok: false, strategy: 'deeplink', error: 'a new workspace needs a repo or a first prompt' }
	}
	const query = [
		prompt.trim() ? `prompt=${encodeURIComponent(prompt)}` : '',
		repoPath ? `path=${encodeURIComponent(repoPath)}` : ''
	]
		.filter(Boolean)
		.join('&')
	try {
		// Serialized with the AX writes: creating a workspace pulls Conductor forward and
		// switches which one is showing, which is precisely what a concurrent send assumes.
		await uiTurn(() => exec('open', [`${CONDUCTOR_SCHEME}://${query}`], { timeout: 15000 }))
		return { ok: true, strategy: 'deeplink' }
	} catch (err) {
		return { ok: false, strategy: 'deeplink', error: osaError(err) }
	}
}

/**
 * Open a new chat in the target workspace — Conductor's "New chat, same files"
 * (Cmd+T). Focuses the workspace first (its own link, see `workspaceLink`), then
 * Cmd+T; the caller detects the freshly-created session id from the DB.
 *
 * The pane is asserted before the keystroke for the same reason a send asserts before
 * typing: `focusWorkspace` confirms every route it takes except its last one, the
 * palette, and Cmd+T against an unconfirmed pane opens a tab in someone else's
 * workspace. Nothing catches that afterwards — the caller looks for the new session in
 * *this* workspace's tab list, so a stray tab reads as "the id could not be read back"
 * while sitting in a conversation nobody asked to change.
 *
 * Cmd+L ("Focus chat input") goes first for the reason `cancelAgent` does the same: a
 * keystroke lands wherever focus is, and a focused terminal panel swallows this one.
 * Measured live before the fix — the run reported success, `sessions` gained nothing,
 * and `terminal_sessions` gained a row in this very workspace at the second the chord
 * was sent. Both chords are Conductor's own, confirmed against its Cmd+/ dialog.
 */
export async function newChat(workspace: Workspace): Promise<SendResult> {
	if (!focusQuery(workspace)) return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
set strips to my tabGroups()
if (count of strips) is 0 then error "couldn't find the chat pane to open a tab in"
my assertWorkspace(item 1 of strips)
tell application "System Events"
	keystroke "l" using {command down}
	delay 0.2
	keystroke "t" using {command down}
end tell`.trim()
	try {
		// Shares the focus path with a send, so it needs the same ceiling: 15s was under
		// the cost of activating a cold Conductor and finding the row on its own.
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Start or stop the selected workspace Run task through Conductor's own toolbar.
 *
 * The task stays owned by Conductor — it appears in the Run panel, inherits the
 * repository's run mode and environment, and Conductor performs its normal
 * process-group shutdown. The relay only presses the same Run/Stop button a
 * person would, after focusing and asserting the target workspace.
 */
export async function setRunTask(workspace: Workspace, running: boolean): Promise<RunTaskResult> {
	if (!focusQuery(workspace)) return { ok: false, error: 'workspace has no branch to focus' }
	const script = `
${CONDUCTOR_HANDLERS}

set wantRunning to (system attribute "RELAY_RUN_WANTED") is "1"
return my setRunTask(wantRunning)`.trim()
	try {
		const { stdout } = await withTargetEnvironment(
			{ workspace, sessionId: workspace.active_session_id },
			targetEnvironment =>
				uiTurn(() =>
					exec('osascript', ['-e', script], {
						env: {
							...process.env,
							...targetEnvironment,
							RELAY_RUN_WANTED: running ? '1' : '0'
						},
						timeout: SEND_ATTEMPT_MS
					})
				)
		)
		const [state, task, changed, rawPorts = ''] = stdout.trim().split('\t')
		if (state !== 'running' && state !== 'stopped') throw new Error(`unexpected Run state: ${state || 'empty'}`)
		const ports = rawPorts
			.split(',')
			.map(Number)
			.filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
		return { ok: true, state, task, changed: changed === 'true', ports }
	} catch (err) {
		return { ok: false, error: osaError(err, 'Conductor took too long to change the Run task') }
	}
}

export type WriteStrategy = 'applescript' | 'sidecar'

export function pickActuator(strategy: WriteStrategy): Actuator {
	return strategy === 'sidecar' ? new SidecarActuator() : new AppleScriptActuator()
}

/** Effective actuator description for the UI, factoring in runtime availability. */
export async function describeActuator(actuator: Actuator): Promise<ActuatorInfo> {
	const available = actuator.available ? await actuator.available().catch(() => false) : true
	return { name: actuator.name, caveat: actuator.caveat, precise: actuator.precise, available }
}
