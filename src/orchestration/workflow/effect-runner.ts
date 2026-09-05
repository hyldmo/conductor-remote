import { type ChildProcess, execFile, spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { ProcessIdentity } from '../persistence/db.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_KILL_GRACE_MS = 500
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const GATE_PROTOCOL_VERSION = 1

/**
 * The wrapper receives no target command in argv or its environment. It waits for
 * one newline-delimited descriptor on private fd 3, then and only then spawns the
 * target inside its own process group. Pipe EOF before that descriptor is a no-op.
 */
const GATED_WRAPPER_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const gate = fs.createReadStream(null, { fd: 3, encoding: 'utf8', autoClose: true });
let input = '';
let launched = false;
const fail = code => { if (!launched) process.exit(code); };
gate.on('data', chunk => {
  if (launched) return;
  input += chunk;
  if (Buffer.byteLength(input) > 4 * 1024 * 1024) return fail(76);
  const newline = input.indexOf('\n');
  if (newline < 0) return;
  launched = true;
  gate.destroy();
  let message;
  try { message = JSON.parse(input.slice(0, newline)); } catch { return process.exit(77); }
  if (!message || message.version !== ${GATE_PROTOCOL_VERSION} || message.go !== true || typeof message.command !== 'string') {
    return process.exit(78);
  }
  const child = spawn(message.command, message.args || [], {
    cwd: message.cwd || undefined,
    env: { ...process.env, ...(message.env || {}) },
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.once('error', error => {
    process.stderr.write(String(error && error.stack || error));
    process.exit(79);
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.stderr.write('\n[target terminated by ' + signal + ']');
      process.exit(80);
    }
    process.exit(code == null ? 81 : code);
  });
});
gate.once('end', () => fail(74));
gate.once('error', () => fail(75));
`

export interface WorkflowExternalProcess extends ProcessIdentity {
	/** The detached wrapper is the leader; its PID is the only safe group target. */
	processGroup: number
}

export type WorkflowGatedCommandErrorCode =
	| 'invalid_command'
	| 'spawn_failed'
	| 'identity_failed'
	| 'gate_rejected'
	| 'aborted'
	| 'timed_out'
	| 'output_limit'
	| 'command_failed'

export class WorkflowGatedCommandError extends Error {
	readonly code: WorkflowGatedCommandErrorCode
	readonly phase: 'before_gate' | 'after_gate'
	readonly mayHaveExecuted: boolean
	readonly externalProcess?: WorkflowExternalProcess
	readonly stdout: string
	readonly stderr: string

	constructor(
		code: WorkflowGatedCommandErrorCode,
		message: string,
		options: {
			phase: 'before_gate' | 'after_gate'
			externalProcess?: WorkflowExternalProcess
			stdout?: string
			stderr?: string
			cause?: unknown
		}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = 'WorkflowGatedCommandError'
		this.code = code
		this.phase = options.phase
		this.mayHaveExecuted = options.phase === 'after_gate'
		this.externalProcess = options.externalProcess
		this.stdout = options.stdout ?? ''
		this.stderr = options.stderr ?? ''
	}
}

export interface WorkflowGatedCommandOptions {
	command: string
	args?: readonly string[]
	cwd?: string
	/** Target-only additions travel through the pipe, never through wrapper argv/env. */
	env?: Readonly<Record<string, string>>
	timeoutMs?: number
	killGraceMs?: number
	maxOutputBytes?: number
	signal?: AbortSignal
	/**
	 * Persist this exact identity and the effect's mayExecute boundary here. The
	 * returned promise must commit before the runner writes GO to the private pipe.
	 */
	onSpawned(process: WorkflowExternalProcess): Promise<void>
	/** Injectable only for deterministic tests; production uses `ps` start identity. */
	readProcessStartedAt?: (pid: number) => Promise<string>
}

export interface WorkflowGatedCommandResult {
	code: 0
	stdout: string
	stderr: string
	externalProcess: WorkflowExternalProcess
}

interface Completion {
	code: number | null
	signal: NodeJS.Signals | null
}

function validate(options: WorkflowGatedCommandOptions): void {
	if (!options.command.trim() || options.command.includes('\0')) {
		throw new WorkflowGatedCommandError('invalid_command', 'Workflow gated command must be non-empty.', {
			phase: 'before_gate'
		})
	}
	for (const argument of options.args ?? []) {
		if (argument.includes('\0')) {
			throw new WorkflowGatedCommandError('invalid_command', 'Workflow gated command arguments cannot contain NUL.', {
				phase: 'before_gate'
			})
		}
	}
	if (options.cwd?.includes('\0')) {
		throw new WorkflowGatedCommandError('invalid_command', 'Workflow gated command cwd cannot contain NUL.', {
			phase: 'before_gate'
		})
	}
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
			throw new WorkflowGatedCommandError('invalid_command', 'Workflow gated command environment is invalid.', {
				phase: 'before_gate'
			})
		}
	}
}

async function processStartedAt(pid: number): Promise<string> {
	const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
		timeout: 2_000,
		maxBuffer: 16_384
	})
	const value = stdout.trim().replace(/\s+/g, ' ')
	if (!value) throw new Error(`ps returned no start identity for PID ${pid}`)
	return value
}

function terminateGroup(pid: number, signal: NodeJS.Signals): void {
	if (!Number.isSafeInteger(pid) || pid <= 1) return
	try {
		process.kill(-pid, signal)
	} catch (error) {
		if (!error || typeof error !== 'object' || !('code' in error)) throw error
		if (error.code === 'ESRCH') return
		// A just-spawned detached child can briefly exist before setsid has made its
		// PID addressable as a process group. Killing that exact validated PID keeps
		// the still-closed gate safe; after release the group path is required.
		if (error.code === 'EPERM') {
			try {
				process.kill(pid, signal)
			} catch (fallback) {
				if (!fallback || typeof fallback !== 'object' || !('code' in fallback) || fallback.code !== 'ESRCH')
					throw fallback
			}
			return
		}
		throw error
	}
}

function closeGate(gate: Writable): void {
	if (!gate.destroyed) gate.destroy()
}

/**
 * Execute one external GUI helper with a crash-safe start gate.
 *
 * The durable callback observes the blocked wrapper first. Only after it resolves
 * does GO plus the private command descriptor cross fd 3. The detached wrapper
 * remains the process-group leader until the target exits, so recovery has one
 * stable PID/start identity and timeout cleanup can address the whole group.
 */
export async function runGatedWorkflowCommand(
	options: WorkflowGatedCommandOptions
): Promise<WorkflowGatedCommandResult> {
	validate(options)
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
	const killGraceMs = Math.max(1, Math.floor(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS))
	const maxOutputBytes = Math.max(1, Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES))
	let wrapper: ChildProcess
	try {
		wrapper = spawn(process.execPath, ['-e', GATED_WRAPPER_SOURCE], {
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe']
		})
	} catch (cause) {
		throw new WorkflowGatedCommandError('spawn_failed', 'Could not spawn the gated Workflow wrapper.', {
			phase: 'before_gate',
			cause
		})
	}
	const pid = wrapper.pid
	const gate = wrapper.stdio[3] as Writable | null
	if (!pid || pid <= 1 || !gate) {
		wrapper.kill()
		throw new WorkflowGatedCommandError('spawn_failed', 'The gated Workflow wrapper exposed no safe PID or pipe.', {
			phase: 'before_gate'
		})
	}

	let stdout = ''
	let stderr = ''
	let outputBytes = 0
	let gateReleased = false
	let timeout = false
	let aborted = options.signal?.aborted ?? false
	let outputLimit = false
	let settled = false
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined
	let completionResolve: ((completion: Completion) => void) | undefined
	const completion = new Promise<Completion>(resolve => {
		completionResolve = resolve
	})
	const settle = (value: Completion) => {
		if (settled) return
		settled = true
		if (forceKillTimer) clearTimeout(forceKillTimer)
		completionResolve?.(value)
	}
	const armForceKill = () => {
		if (forceKillTimer || settled) return
		forceKillTimer = setTimeout(() => terminateGroup(pid, 'SIGKILL'), killGraceMs)
	}
	const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
		outputBytes += chunk.byteLength
		if (outputBytes > maxOutputBytes) {
			outputLimit = true
			terminateGroup(pid, 'SIGTERM')
			armForceKill()
			return
		}
		if (stream === 'stdout') stdout += chunk.toString('utf8')
		else stderr += chunk.toString('utf8')
	}
	wrapper.stdout?.on('data', chunk => collect('stdout', Buffer.from(chunk)))
	wrapper.stderr?.on('data', chunk => collect('stderr', Buffer.from(chunk)))
	wrapper.once('error', () => settle({ code: null, signal: null }))
	wrapper.once('close', (code, signal) => settle({ code, signal }))

	const abort = () => {
		aborted = true
		closeGate(gate)
		terminateGroup(pid, 'SIGTERM')
		armForceKill()
	}
	options.signal?.addEventListener('abort', abort, { once: true })
	const timer = setTimeout(() => {
		timeout = true
		closeGate(gate)
		terminateGroup(pid, 'SIGTERM')
		armForceKill()
	}, timeoutMs)

	let externalProcess: WorkflowExternalProcess | undefined
	try {
		let startedAt: string
		try {
			startedAt = await (options.readProcessStartedAt ?? processStartedAt)(pid)
		} catch (cause) {
			closeGate(gate)
			terminateGroup(pid, 'SIGTERM')
			throw new WorkflowGatedCommandError('identity_failed', 'Could not prove the gated wrapper process identity.', {
				phase: 'before_gate',
				cause
			})
		}
		externalProcess = { pid, processStartedAt: startedAt, processGroup: pid }
		if (aborted || timeout) {
			throw new WorkflowGatedCommandError(
				aborted ? 'aborted' : 'timed_out',
				'Workflow command stopped before gate registration.',
				{
					phase: 'before_gate',
					externalProcess
				}
			)
		}
		try {
			await options.onSpawned(externalProcess)
		} catch (cause) {
			closeGate(gate)
			terminateGroup(pid, 'SIGTERM')
			throw new WorkflowGatedCommandError(
				'gate_rejected',
				'Durable Workflow process registration failed before gate release.',
				{ phase: 'before_gate', externalProcess, cause }
			)
		}
		if (aborted || timeout) {
			throw new WorkflowGatedCommandError(
				aborted ? 'aborted' : 'timed_out',
				'Workflow command stopped before gate release.',
				{
					phase: 'before_gate',
					externalProcess
				}
			)
		}
		const descriptor = JSON.stringify({
			version: GATE_PROTOCOL_VERSION,
			go: true,
			command: options.command,
			args: [...(options.args ?? [])],
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.env ? { env: options.env } : {})
		})
		await new Promise<void>((resolve, reject) => {
			const failed = (error: Error) => reject(error)
			gate.once('error', failed)
			gate.end(`${descriptor}\n`, () => {
				gate.off('error', failed)
				resolve()
			})
		})
		gateReleased = true

		const finished = await completion
		if (timeout) {
			throw new WorkflowGatedCommandError('timed_out', 'Workflow command exceeded its deadline.', {
				phase: 'after_gate',
				externalProcess,
				stdout,
				stderr
			})
		}
		if (aborted) {
			throw new WorkflowGatedCommandError('aborted', 'Workflow command was aborted.', {
				phase: 'after_gate',
				externalProcess,
				stdout,
				stderr
			})
		}
		if (outputLimit) {
			throw new WorkflowGatedCommandError('output_limit', 'Workflow command exceeded its output limit.', {
				phase: 'after_gate',
				externalProcess,
				stdout,
				stderr
			})
		}
		if (finished.code !== 0) {
			throw new WorkflowGatedCommandError(
				'command_failed',
				`Workflow command exited with ${finished.signal ?? finished.code ?? 'no status'}.`,
				{ phase: 'after_gate', externalProcess, stdout, stderr }
			)
		}
		return { code: 0, stdout, stderr, externalProcess }
	} catch (error) {
		if (!settled) {
			closeGate(gate)
			terminateGroup(pid, 'SIGTERM')
			await Promise.race([completion, new Promise(resolve => setTimeout(resolve, killGraceMs))])
			if (!settled) terminateGroup(pid, 'SIGKILL')
			await completion
		}
		if (error instanceof WorkflowGatedCommandError) throw error
		throw new WorkflowGatedCommandError('gate_rejected', 'The private Workflow execution gate failed.', {
			phase: gateReleased ? 'after_gate' : 'before_gate',
			externalProcess,
			stdout,
			stderr,
			cause: error
		})
	} finally {
		clearTimeout(timer)
		if (forceKillTimer) clearTimeout(forceKillTimer)
		options.signal?.removeEventListener('abort', abort)
	}
}
