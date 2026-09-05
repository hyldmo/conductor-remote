import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The agent harnesses Conductor currently offers. */
export type PlanUsageProviderId = 'claude' | 'codex' | 'cursor' | 'opencode'

export interface PlanUsageWindow {
	id: string
	label: string
	/** Percentage of this rolling allowance consumed, clamped to 0–100. */
	usedPercent: number
	/** Unix time in milliseconds, or null when the provider omits it. */
	resetsAt: number | null
	/** Provider-reported rolling-window size. Claude does not expose this directly. */
	windowDurationMins?: number | null
	/** Claude marks the bucket currently constraining requests. */
	active?: boolean
}

export interface PlanUsageBucket {
	id: string
	label: string
	windows: PlanUsageWindow[]
}

export interface ProviderPlanUsage {
	provider: PlanUsageProviderId
	label: string
	status: 'available' | 'unavailable' | 'error'
	plan: string | null
	buckets: PlanUsageBucket[]
	/** Safe, user-facing explanation. Raw CLI failures only go to the relay log. */
	message?: string
}

export interface PlanUsageSnapshot {
	providers: ProviderPlanUsage[]
	/** When these provider reads completed, as Unix time in milliseconds. */
	fetchedAt: number
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function percent(value: unknown): number | null {
	const parsed = number(value)
	return parsed === null ? null : Math.max(0, Math.min(100, parsed))
}

function timestamp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		// Codex reports seconds; tolerate milliseconds if the protocol changes.
		return value < 10_000_000_000 ? value * 1000 : value
	}
	if (typeof value !== 'string') return null
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : null
}

function codexWindowLabel(duration: number | null, slot: 'primary' | 'secondary'): string {
	if (duration === 300) return '5-hour limit'
	if (duration === 1_440) return 'Daily limit'
	if (duration === 10_080) return 'Weekly limit'
	if (duration && duration % 1_440 === 0) return `${duration / 1_440}-day limit`
	if (duration && duration % 60 === 0) return `${duration / 60}-hour limit`
	return slot === 'primary' ? 'Primary limit' : 'Secondary limit'
}

function codexWindow(bucketId: string, slot: 'primary' | 'secondary', raw: unknown): PlanUsageWindow | null {
	const value = object(raw)
	const usedPercent = percent(value?.usedPercent)
	if (!value || usedPercent === null) return null
	const duration = number(value.windowDurationMins)
	return {
		id: `${bucketId}:${slot}`,
		label: codexWindowLabel(duration, slot),
		usedPercent,
		resetsAt: timestamp(value.resetsAt),
		windowDurationMins: duration
	}
}

/** Reduce Codex's app-server response to the stable, provider-neutral wire shape. */
export function parseCodexPlanUsage(raw: unknown): ProviderPlanUsage {
	const envelope = object(raw)
	const payload = object(envelope?.result) ?? envelope
	const legacy = object(payload?.rateLimits)
	const byLimit = object(payload?.rateLimitsByLimitId)
	const entries: Array<[string, unknown]> =
		byLimit && Object.keys(byLimit).length ? Object.entries(byLimit) : legacy ? [['codex', legacy]] : []
	const buckets: PlanUsageBucket[] = []
	let plan: string | null = null

	for (const [key, candidate] of entries) {
		const snapshot = object(candidate)
		if (!snapshot) continue
		plan ??= text(snapshot.planType)
		const id = text(snapshot.limitId) ?? key
		const windows = (
			[
				codexWindow(id, 'primary', snapshot.primary),
				codexWindow(id, 'secondary', snapshot.secondary)
			] satisfies Array<PlanUsageWindow | null>
		).filter((window): window is PlanUsageWindow => window !== null)
		if (!windows.length) continue
		buckets.push({ id, label: text(snapshot.limitName) ?? (id === 'codex' ? 'Codex' : id), windows })
	}

	if (!buckets.length) {
		return {
			provider: 'codex',
			label: 'Codex',
			status: 'unavailable',
			plan,
			buckets: [],
			message: 'Codex returned no rolling plan limits for this account.'
		}
	}
	buckets.sort((a, b) => Number(b.id === 'codex') - Number(a.id === 'codex') || a.label.localeCompare(b.label))
	return { provider: 'codex', label: 'Codex', status: 'available', plan, buckets }
}

function claudeWindowLabel(limit: JsonObject): string {
	const kind = text(limit.kind)
	const model = text(object(object(limit.scope)?.model)?.display_name)
	if (kind === 'session') return 'Current session'
	if (kind === 'weekly_all') return 'Current week'
	if (kind === 'weekly_scoped' && model) return `Current week (${model})`
	if (model) return model
	return kind?.replaceAll('_', ' ') ?? 'Plan limit'
}

function claudeWindow(id: string, label: string, raw: unknown, active?: boolean): PlanUsageWindow | null {
	const value = object(raw)
	const usedPercent = percent(value?.utilization ?? value?.percent)
	if (!value || usedPercent === null) return null
	return {
		id,
		label,
		usedPercent,
		resetsAt: timestamp(value.resets_at),
		...(active === undefined ? {} : { active })
	}
}

/** Reduce Claude's experimental `get_usage` control response; tolerate its older named-window shape. */
export function parseClaudePlanUsage(raw: unknown): ProviderPlanUsage {
	const envelope = object(raw)
	const control = object(envelope?.response)
	const payload = object(control?.response) ?? envelope
	const plan = text(payload?.subscription_type)
	if (payload?.rate_limits_available === false) {
		return {
			provider: 'claude',
			label: 'Claude Code',
			status: 'unavailable',
			plan,
			buckets: [],
			message: 'Plan limits are not available for API-key or third-party-provider sessions.'
		}
	}

	const rateLimits = object(payload?.rate_limits)
	const windows: PlanUsageWindow[] = []
	const limits = Array.isArray(rateLimits?.limits) ? rateLimits.limits : []
	for (const [index, candidate] of limits.entries()) {
		const limit = object(candidate)
		if (!limit) continue
		const kind = text(limit.kind)
		// These are the rolling plan allowances. Spend/credit records have a different
		// unit and belong in a future money-shaped control rather than a percentage bar.
		if (!kind || !['session', 'weekly_all', 'weekly_scoped'].includes(kind)) continue
		const model = text(object(object(limit.scope)?.model)?.display_name)
		const parsed = claudeWindow(
			`claude:${kind}:${model ?? index}`,
			claudeWindowLabel(limit),
			limit,
			limit.is_active === true
		)
		if (parsed) windows.push(parsed)
	}

	// Claude 2.1 first exposed the same data as named fields. Keep this fallback so an
	// app update that removes the additive `limits` array does not blank the whole card.
	if (!windows.length && rateLimits) {
		const named: Array<[string, string]> = [
			['five_hour', 'Current session'],
			['seven_day', 'Current week'],
			['seven_day_opus', 'Current week (Opus)'],
			['seven_day_sonnet', 'Current week (Sonnet)']
		]
		for (const [key, label] of named) {
			const parsed = claudeWindow(`claude:${key}`, label, rateLimits[key])
			if (parsed) windows.push(parsed)
		}
		const scoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []
		for (const [index, candidate] of scoped.entries()) {
			const value = object(candidate)
			const model = text(value?.display_name)
			const parsed = claudeWindow(
				`claude:model:${model ?? index}:${index}`,
				`Current week (${model ?? 'model'})`,
				value
			)
			if (parsed) windows.push(parsed)
		}
	}

	if (!windows.length) {
		return {
			provider: 'claude',
			label: 'Claude Code',
			status: 'unavailable',
			plan,
			buckets: [],
			message: 'Claude Code returned no rolling plan limits for this account.'
		}
	}
	return {
		provider: 'claude',
		label: 'Claude Code',
		status: 'available',
		plan,
		buckets: [{ id: 'claude', label: 'Claude Code', windows }]
	}
}

const BUNDLED_BINARIES = path.join(
	os.homedir(),
	'Library',
	'Application Support',
	'com.conductor.app',
	'agent-binaries'
)

/** Prefer the CLI Conductor runs, falling back to the user's PATH for older app installs. */
function agentBinary(provider: 'claude' | 'codex'): string {
	const root = path.join(BUNDLED_BINARIES, provider)
	try {
		const versions = fs
			.readdirSync(root, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
		for (const version of versions) {
			const candidate = path.join(root, version, provider)
			try {
				fs.accessSync(candidate, fs.constants.X_OK)
				return candidate
			} catch {
				// A half-downloaded version is not a CLI; try the next one.
			}
		}
	} catch {
		// Conductor did not bundle this harness yet; spawn can still resolve the user's CLI.
	}
	return provider
}

interface ChildFailure extends Error {
	code?: string
}

const MAX_CLI_OUTPUT = 4 * 1024 * 1024

function failureMessage(name: string, stderr: string, code: number | null): Error {
	const detail = stderr.trim().slice(-2_000)
	return new Error(
		`${name} exited before returning usage${code === null ? '' : ` (${code})`}${detail ? `: ${detail}` : ''}`
	)
}

function codexResponse(binary = agentBinary('codex')): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		let requested = false
		let settled = false
		const finish = (error: Error | null, result?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill()
			if (error) reject(error)
			else resolve(result)
		}
		const timer = setTimeout(() => finish(new Error('Codex plan-usage read timed out')), 8_000)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', chunk => {
			stderr = (stderr + chunk).slice(-MAX_CLI_OUTPUT)
		})
		child.stdout.on('data', chunk => {
			stdout += chunk
			if (stdout.length > MAX_CLI_OUTPUT) return finish(new Error('Codex plan-usage response was too large'))
			let newline = stdout.indexOf('\n')
			while (newline >= 0) {
				const line = stdout.slice(0, newline).trim()
				stdout = stdout.slice(newline + 1)
				newline = stdout.indexOf('\n')
				if (!line) continue
				let message: JsonObject
				try {
					message = JSON.parse(line) as JsonObject
				} catch {
					continue
				}
				if (message.id === 1 && !requested) {
					requested = true
					child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
					child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`)
				} else if (message.id === 2) {
					if (message.error) return finish(new Error('Codex rejected the plan-usage request'))
					return finish(null, message)
				}
			}
		})
		child.on('error', error => finish(error))
		child.on('close', code => finish(failureMessage('Codex', stderr, code)))
		child.stdin.on('error', error => finish(error))
		child.stdin.write(
			`${JSON.stringify({
				id: 1,
				method: 'initialize',
				params: { clientInfo: { name: 'conductor-remote', version: '1' } }
			})}\n`
		)
	})
}

function claudeResponse(binary = agentBinary('claude')): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			binary,
			[
				'-p',
				'--input-format',
				'stream-json',
				'--output-format',
				'stream-json',
				'--verbose',
				'--no-session-persistence',
				'--safe-mode'
			],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		)
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (error: Error | null, result?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.kill()
			if (error) reject(error)
			else resolve(result)
		}
		const timer = setTimeout(() => finish(new Error('Claude plan-usage read timed out')), 10_000)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', chunk => {
			stderr = (stderr + chunk).slice(-MAX_CLI_OUTPUT)
		})
		child.stdout.on('data', chunk => {
			stdout += chunk
			if (stdout.length > MAX_CLI_OUTPUT) return finish(new Error('Claude plan-usage response was too large'))
			let newline = stdout.indexOf('\n')
			while (newline >= 0) {
				const line = stdout.slice(0, newline).trim()
				stdout = stdout.slice(newline + 1)
				newline = stdout.indexOf('\n')
				if (!line) continue
				let message: JsonObject
				try {
					message = JSON.parse(line) as JsonObject
				} catch {
					continue
				}
				const response = object(message.response)
				if (message.type !== 'control_response' || response?.request_id !== 'plan-usage') continue
				if (response.subtype !== 'success')
					return finish(new Error('Claude rejected the structured plan-usage request'))
				return finish(null, message)
			}
		})
		child.on('error', error => finish(error))
		child.on('close', code => finish(failureMessage('Claude', stderr, code)))
		child.stdin.on('error', error => finish(error))
		child.stdin.end(
			`${JSON.stringify({
				type: 'control_request',
				request_id: 'plan-usage',
				request: { subtype: 'get_usage' }
			})}\n`
		)
	})
}

function unavailable(provider: PlanUsageProviderId, label: string, message: string): ProviderPlanUsage {
	return { provider, label, status: 'unavailable', plan: null, buckets: [], message }
}

function failed(provider: PlanUsageProviderId, label: string, error: unknown): ProviderPlanUsage {
	const detail = error instanceof Error ? error.message : String(error)
	console.warn(`[relay] ${label} plan usage failed: ${detail}`)
	const missing = (error as ChildFailure | null)?.code === 'ENOENT'
	return {
		provider,
		label,
		status: missing ? 'unavailable' : 'error',
		plan: null,
		buckets: [],
		message: missing ? `${label} is not installed on this Mac.` : `Could not read plan usage from ${label}.`
	}
}

export async function readCodexPlanUsage(): Promise<ProviderPlanUsage> {
	try {
		return parseCodexPlanUsage(await codexResponse())
	} catch (error) {
		return failed('codex', 'Codex', error)
	}
}

export async function readClaudePlanUsage(): Promise<ProviderPlanUsage> {
	try {
		return parseClaudePlanUsage(await claudeResponse())
	} catch (error) {
		return failed('claude', 'Claude Code', error)
	}
}

export interface PlanUsageReader {
	provider: PlanUsageProviderId
	label: string
	read: () => Promise<ProviderPlanUsage>
}

const DEFAULT_READERS: PlanUsageReader[] = [
	{ provider: 'claude', label: 'Claude Code', read: readClaudePlanUsage },
	{ provider: 'codex', label: 'Codex', read: readCodexPlanUsage }
]

const UNSUPPORTED: ProviderPlanUsage[] = [
	unavailable('cursor', 'Cursor Agent', 'Cursor Agent does not expose plan limits through its CLI.'),
	unavailable('opencode', 'OpenCode', 'OpenCode reports local token and cost totals, not provider plan limits.')
]

/** Coalesced provider reads. `/api/usage` may be opened from several phones at once. */
export class PlanUsageService {
	private readonly readers: PlanUsageReader[]
	private readonly cacheMs: number
	private readonly now: () => number
	private cached: PlanUsageSnapshot | null = null
	private inFlight: Promise<PlanUsageSnapshot> | null = null

	constructor(options: { readers?: PlanUsageReader[]; cacheMs?: number; now?: () => number } = {}) {
		this.readers = options.readers ?? DEFAULT_READERS
		this.cacheMs = options.cacheMs ?? 60_000
		this.now = options.now ?? Date.now
	}

	read(force = false): Promise<PlanUsageSnapshot> {
		if (!force && this.cached && this.now() - this.cached.fetchedAt < this.cacheMs) return Promise.resolve(this.cached)
		if (this.inFlight) return this.inFlight

		const pending = Promise.all(
			this.readers.map(async reader => {
				try {
					return await reader.read()
				} catch (error) {
					return failed(reader.provider, reader.label, error)
				}
			})
		).then(providers => {
			const snapshot = { providers: [...providers, ...UNSUPPORTED], fetchedAt: this.now() }
			this.cached = snapshot
			return snapshot
		})
		this.inFlight = pending
		void pending.finally(() => {
			if (this.inFlight === pending) this.inFlight = null
		})
		return pending
	}
}
