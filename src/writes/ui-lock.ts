import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runGatedWorkflowCommand, type WorkflowExternalProcess } from '../orchestration/workflow/effect-runner.ts'

interface ExecOptions {
	cwd?: string
	env?: NodeJS.ProcessEnv
	timeout?: number
	maxBuffer?: number
	signal?: AbortSignal
}

const execDirect = promisify(execFile) as (
	command: string,
	args: string[],
	options?: ExecOptions
) => Promise<{ stdout: string; stderr: string }>

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
 * on its own schedule (`src/delivery/firstprompt.ts`), so the queue can now fire while the
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

const UI_BUSY = "Conductor's UI is busy"

const uiPriorityScope = new AsyncLocalStorage<UiPriority>()

export interface SharedUiLeaseRequest {
	priority: UiPriority
	/** Stable Workflow effect id when this turn belongs to a durable effect. */
	actionId?: string
}

export interface SharedUiLease {
	/**
	 * Persist the boundary after which this owner may have touched Conductor.
	 * Gated Workflow turns include the exact blocked wrapper identity.
	 */
	markMayExecute(externalProcess?: WorkflowExternalProcess): void | Promise<void>
	release(): void | Promise<void>
}

/** Installed by the server's orchestration store; absent keeps standalone callers usable. */
export interface SharedUiLeaseProvider {
	acquire(request: SharedUiLeaseRequest): Promise<SharedUiLease>
}

export type UiDispatchHook = () => void | Promise<void>

interface UiDispatchContext {
	actionId?: string
	hook: UiDispatchHook
	fired: boolean
	firing?: Promise<void>
	/** One process-shared lease spans the entire durable effect, including its receipt commit. */
	lease?: SharedUiLease
}

const uiDispatchScope = new AsyncLocalStorage<UiDispatchContext>()

interface UiCommandGateContext {
	onSpawned(process: WorkflowExternalProcess): Promise<void>
}

interface UiLeaseExecutionContext {
	lease: SharedUiLease | null
	gate?: UiCommandGateContext
	commandRunning: boolean
	active: boolean
}

const uiCommandGateScope = new AsyncLocalStorage<UiCommandGateContext>()

const uiLeaseExecutionScope = new AsyncLocalStorage<UiLeaseExecutionContext>()

let sharedUiLeaseProvider: SharedUiLeaseProvider | null = null

/** Route every subsequent UI turn through a cooperating cross-process lease. */
export function configureSharedUiLeaseProvider(provider: SharedUiLeaseProvider | null): void {
	sharedUiLeaseProvider = provider
}

/**
 * Mark one durable effect as dispatched immediately before its first GUI action.
 * Several UI turns may be needed to configure and send one effect; the shared scope
 * makes the durable transition exactly once across all of them.
 */
export function withUiDispatchHook<T>(hook: UiDispatchHook, fn: () => Promise<T>, actionId?: string): Promise<T> {
	const context: UiDispatchContext = { hook, actionId, fired: false }
	return uiDispatchScope.run(context, async () => {
		try {
			return await fn()
		} finally {
			// The coordinator commits success or ambiguity before its callback settles.
			// Release here so another process can never enter the window between the GUI
			// returning and that durable receipt decision.
			const lease = context.lease
			context.lease = undefined
			await lease?.release()
		}
	})
}

/**
 * Route the first external command executed inside a UI turn through the private
 * Workflow gate. Read-only probes before the UI turn stay in-process; later UI
 * turns are already behind a durable may-execute boundary and run normally.
 */
export function withGatedUiCommand<T>(
	onSpawned: (process: WorkflowExternalProcess) => Promise<void>,
	fn: (execute: typeof exec) => Promise<T>
): Promise<T> {
	if (uiCommandGateScope.getStore()) throw new Error('a gated UI command scope is already active')
	return uiCommandGateScope.run({ onSpawned }, () => fn(exec))
}

function commandEnvironment(environment: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!environment) return undefined
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string' && process.env[entry[0]] !== entry[1]
		)
	)
}

/** Execute an external helper, honoring a Workflow's one-shot private command gate. */
export async function exec(
	command: string,
	args: string[],
	options: ExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
	const gate = uiCommandGateScope.getStore()
	const execution = uiLeaseExecutionScope.getStore()
	if (execution && !execution.active) throw new Error('a UI command escaped its shared lease')
	if (!gate || execution?.gate !== gate) return execDirect(command, args, options)
	if (execution.commandRunning) throw new Error('gated UI commands must execute sequentially')

	// Claim synchronously so two accidentally-overlapping commands can never both
	// obtain a GO descriptor from one durable effect. Sequential commands refresh
	// the persisted external identity before each new GO.
	execution.commandRunning = true
	try {
		const result = await runGatedWorkflowCommand({
			command,
			args,
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.env ? { env: commandEnvironment(options.env) } : {}),
			...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
			...(options.maxBuffer === undefined ? {} : { maxOutputBytes: options.maxBuffer }),
			...(options.signal ? { signal: options.signal } : {}),
			onSpawned: async process => {
				// Neither commit alone releases the wrapper. GO crosses the pipe only after
				// both the effect and the cross-process mutex carry this exact identity.
				await gate.onSpawned(process)
				await execution.lease?.markMayExecute(process)
			}
		})
		return { stdout: result.stdout, stderr: result.stderr }
	} finally {
		execution.commandRunning = false
	}
}

async function markUiDispatched(context: UiDispatchContext | undefined): Promise<void> {
	if (!context || context.fired) return
	if (!context.firing) {
		context.firing = Promise.resolve()
			.then(() => context.hook())
			.then(() => {
				context.fired = true
			})
	}
	await context.firing
}

/** Run `fn` with every UI operation it triggers marked at `priority`. */
export function withUiPriority<T>(priority: UiPriority, fn: () => Promise<T>): Promise<T> {
	return uiPriorityScope.run(priority, fn)
}

export class UiBusyError extends Error {
	readonly waiting: number
	constructor(waiting: number) {
		super(`${UI_BUSY} — ${waiting} operation${waiting === 1 ? '' : 's'} already queued. Try again shortly.`)
		this.name = 'UiBusyError'
		this.waiting = waiting
	}
}

/** Writes stringify `UiBusyError`, so background queues recognize both forms. */
export function uiBusy(error: string | undefined): boolean {
	return (error ?? '').startsWith(UI_BUSY)
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
 * Take the lock, run `op`, release it. Exported for `tests/writes/ui-lock.test.ts`,
 * which is the only way this queue's control flow gets read by anything.
 */
export function uiTurn<T>(op: () => Promise<T>): Promise<T> {
	// High-level Workflow effects hold one cross-process lease through their durable
	// receipt poll. Existing actuator helpers still call uiTurn internally; reusing
	// the outer lease keeps that nesting from deadlocking or opening a correlation gap.
	if (uiLeaseExecutionScope.getStore()?.active) return Promise.resolve().then(op)
	const rank = uiPriorityScope.getStore() === 'background' ? 1 : 0
	// A queued callback is eventually started from the previous owner's async chain,
	// so capture the effect scope now rather than consulting AsyncLocalStorage later.
	const dispatch = uiDispatchScope.getStore()
	const commandGate = uiCommandGateScope.getStore()
	if (uiWaiting.length >= MAX_UI_QUEUE) return Promise.reject(new UiBusyError(uiWaiting.length))
	return new Promise<T>((resolve, reject) => {
		const waiter: UiWaiter = {
			rank,
			seq: uiSeq++,
			start: () => {
				const priority: UiPriority = rank === 1 ? 'background' : 'interactive'
				const provider = sharedUiLeaseProvider
				// Acquire the process-shared lease only after this operation owns the local
				// priority lock. The dispatch transition follows both locks and precedes the
				// first instruction in `op`, so a failure before it is provably replayable.
				const settled = (async () => {
					let lease: SharedUiLease | null = null
					let releaseHere = true
					try {
						lease = dispatch?.lease ?? null
						if (!lease && provider) {
							lease = await provider.acquire({
								priority,
								...(dispatch?.actionId ? { actionId: dispatch.actionId } : {})
							})
							if (dispatch) dispatch.lease = lease
						}
						releaseHere = !dispatch
						await markUiDispatched(dispatch)
						// An ordinary turn becomes potentially mutating immediately before its
						// operation. A Workflow's first external command instead supplies the
						// blocked wrapper identity and flips this boundary from inside `exec`.
						const pendingGate = commandGate
						if (!pendingGate) await lease?.markMayExecute()
						const execution: UiLeaseExecutionContext = {
							lease,
							commandRunning: false,
							active: true,
							...(pendingGate ? { gate: pendingGate } : {})
						}
						try {
							return await uiLeaseExecutionScope.run(execution, op)
						} finally {
							execution.active = false
						}
					} finally {
						// A lease release participates in the operation's result. In particular, do
						// not tell a caller the UI is free while another process still sees us as
						// its durable owner.
						if (releaseHere) await lease?.release()
					}
				})()
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
