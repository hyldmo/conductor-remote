import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicJson } from './config.ts'
import type { AutoModelConfig, AutoModelDecision, AutoModelJob, AutoModelPending, AutoModelState } from './types.ts'

export interface AutoTarget {
	sessionId?: string
	ready: boolean
	worktree?: string | null
	error?: string
	obsolete?: boolean
}

export interface AutoQueueDeps {
	inspect: (job: AutoModelJob) => AutoTarget
	locked: () => Promise<boolean>
	choose: (job: AutoModelJob, worktree: string) => Promise<AutoModelDecision>
	/** Includes materialization, settings, and send under the existing UI mutex. */
	deliver: (
		job: AutoModelJob,
		current: () => boolean,
		dispatch: () => void
	) => Promise<{ ok: boolean; blocked?: boolean; error?: string; cancelled?: boolean }>
	materialize: (job: AutoModelJob, worktree: string) => void
	cursor: (sessionId: string) => NonNullable<AutoModelJob['cursor']>
	received: (job: AutoModelJob) => boolean
	now?: () => number
}

const pending = (job: AutoModelJob) => ['selecting', 'waiting', 'failed'].includes(job.status)

/** One durable file per target; a process lease also keeps dev and installed relays from routing twice. */
export class AutoModelQueue {
	private running = false
	private readonly now: () => number
	private readonly directory: string
	private readonly deps: AutoQueueDeps
	constructor(directory: string, deps: AutoQueueDeps) {
		this.directory = directory
		this.deps = deps
		this.now = deps.now ?? Date.now
		fs.mkdirSync(directory, { recursive: true })
	}
	private file(job: Pick<AutoModelJob, 'id'>): string {
		return path.join(this.directory, `${job.id}.json`)
	}
	list(): AutoModelJob[] {
		return fs
			.readdirSync(this.directory)
			.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
			.map(name => {
				const job = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')) as AutoModelJob
				if (!job.id || !job.config || typeof job.text !== 'string')
					throw new Error('An Auto submission could not be read.')
				return job
			})
	}
	get(sessionId: string | undefined, workspaceId?: string): AutoModelJob | undefined {
		return this.list().find(
			job =>
				(sessionId && job.sessionId === sessionId) || (workspaceId && job.workspaceId === workspaceId && !job.sessionId)
		)
	}
	state(sessionId: string, workspaceId: string): AutoModelState | undefined {
		const job = this.get(sessionId, workspaceId)
		return (
			job && { status: job.status, decision: job.status === 'cancelled' ? undefined : job.decision, error: job.error }
		)
	}
	pending(): AutoModelPending[] {
		return this.list()
			.filter(pending)
			.map(job => ({
				workspaceId: job.workspaceId,
				sessionId: job.sessionId,
				text: job.text,
				createdAt: job.createdAt,
				status: job.status === 'failed' ? 'failed' : 'waiting',
				attempts: job.attempts,
				reason: job.reason,
				error: job.error,
				autoModel: true,
				agent: job.decision && { model: job.decision.model, effort: job.decision.effort, fast: job.decision.fast }
			}))
	}
	accept(input: {
		workspaceId: string
		sessionId?: string
		text: string
		repo: string
		config: AutoModelConfig
		attachmentIds?: string[]
		sendImmediately?: boolean
	}): AutoModelJob {
		const existing = this.get(input.sessionId, input.workspaceId)
		if (existing && existing.status !== 'draft' && existing.status !== 'cancelled') {
			if (existing.text !== input.text)
				throw new Error('This chat already has an Auto submission. Dismiss it before sending another.')
			if (existing.status === 'failed') {
				existing.status = 'waiting'
				existing.attempts = 0
				existing.earlyAttempts = 0
				existing.lastAttemptAt = undefined
				existing.error = undefined
				existing.reason = 'Retrying with the saved model choice'
				this.save(existing)
			}
			return existing
		}
		const job: AutoModelJob = {
			...input,
			config: structuredClone(input.config),
			id:
				existing?.id ??
				crypto
					.createHash('sha256')
					.update(`${input.workspaceId}:${input.sessionId ?? 'first'}`)
					.digest('hex'),
			attachmentIds: input.attachmentIds ?? [],
			sendImmediately: input.sendImmediately !== false,
			createdAt: Math.max(this.now(), (existing?.createdAt ?? 0) + 1),
			attempts: 0,
			earlyAttempts: 0,
			status: input.text ? 'waiting' : 'draft',
			reason: 'Choosing a model…'
		}
		if (existing) this.save(job)
		else {
			try {
				fs.writeFileSync(this.file(job), JSON.stringify(job), { flag: 'wx', mode: 0o600 })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.accept(input)
				throw error
			}
		}
		return job
	}
	cancel(sessionId: string | undefined, workspaceId?: string): boolean {
		const job = this.get(sessionId, workspaceId)
		if (!job || !['draft', 'selecting', 'waiting', 'failed'].includes(job.status)) return false
		const lease = this.readLease(job)
		if (lease?.dispatching && this.alive(lease.pid))
			throw new Error('Auto is sending this prompt now. Wait for its receipt before dismissing it.')
		job.status = 'cancelled'
		job.reason = 'Auto cancelled'
		this.save(job)
		return true
	}
	private save(job: AutoModelJob): void {
		atomicJson(this.file(job), job)
	}
	private current(job: AutoModelJob): boolean {
		const saved = JSON.parse(fs.readFileSync(this.file(job), 'utf8')) as AutoModelJob
		return saved.createdAt === job.createdAt && saved.text === job.text && pending(saved) && saved.status !== 'failed'
	}
	private alive(pid: number): boolean {
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== 'ESRCH'
		}
	}
	private readLease(job: AutoModelJob): { pid: number; dispatching: boolean } | undefined {
		try {
			return JSON.parse(fs.readFileSync(`${this.file(job)}.lock`, 'utf8'))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}
	private lease(job: AutoModelJob): boolean {
		const existing = this.readLease(job)
		if (existing) {
			if (this.alive(existing.pid)) return false
			fs.rmSync(`${this.file(job)}.lock`, { force: true })
		}
		try {
			fs.writeFileSync(`${this.file(job)}.lock`, JSON.stringify({ pid: process.pid, dispatching: false }), {
				flag: 'wx',
				mode: 0o600
			})
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
			throw error
		}
	}
	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			for (const candidate of this.list()) {
				if (!pending(candidate) || candidate.status === 'failed' || !this.lease(candidate)) continue
				const job = JSON.parse(fs.readFileSync(this.file(candidate), 'utf8')) as AutoModelJob
				try {
					if (this.current(job)) await this.step(job)
				} catch (error) {
					if (this.current(job)) {
						job.status = 'failed'
						job.error = error instanceof Error ? error.message : 'Auto could not deliver the prompt.'
						this.save(job)
					}
				} finally {
					fs.rmSync(`${this.file(job)}.lock`, { force: true })
				}
			}
		} finally {
			this.running = false
		}
	}
	private async step(job: AutoModelJob): Promise<void> {
		if (job.sessionId && job.cursor && this.deps.received(job)) {
			job.status = 'delivered'
			this.save(job)
			return
		}
		if (await this.deps.locked()) {
			if (!this.current(job)) return
			job.reason = 'Waiting for the Mac to unlock'
			job.lastAttemptAt = this.now()
			this.save(job)
			return
		}
		if (!this.current(job)) return
		const target = this.deps.inspect(job)
		if (target.obsolete) {
			job.status = 'cancelled'
			job.reason = 'The chat started before Auto could send.'
			this.save(job)
			return
		}
		if (target.error) throw new Error(target.error)
		if (!target.sessionId || !target.worktree || (!target.ready && (!job.sendImmediately || job.earlyAttempts >= 2))) {
			if (this.now() - (job.lastAttemptAt ?? job.createdAt) > 15 * 60_000)
				throw new Error('The workspace did not become ready for Auto. Retry when setup finishes.')
			return
		}
		if (job.lastAttemptAt && this.now() - job.lastAttemptAt < 5000) return
		job.sessionId = target.sessionId
		this.deps.materialize(job, target.worktree)
		job.cursor ??= this.deps.cursor(job.sessionId)
		this.save(job)
		if (!job.decision) {
			job.status = 'selecting'
			job.reason = 'Choosing a model…'
			this.save(job)
			const decision = await this.deps.choose(job, target.worktree)
			if (!this.current(job)) return
			job.decision = decision
			job.status = 'waiting'
			job.reason = `${decision.model} selected · ${decision.reason}`
			this.save(job) // Decision is durable before any UI write.
		}
		const result = await this.deps.deliver(
			job,
			() => this.current(job),
			() => {
				atomicJson(`${this.file(job)}.lock`, { pid: process.pid, dispatching: true })
			}
		)
		if (!this.current(job)) return
		if (result.cancelled) job.status = 'cancelled'
		else if (result.ok) job.status = 'delivered'
		else if (result.blocked) job.reason = 'Waiting for the Mac to unlock'
		else {
			if (target.ready) job.attempts++
			else job.earlyAttempts++
			job.error = result.error ?? 'The prompt was not accepted.'
			job.reason = job.error
			if (job.attempts >= 3) job.status = 'failed'
		}
		job.lastAttemptAt = this.now()
		this.save(job)
	}
	start(): () => void {
		const tick = () => void this.tick().catch(error => console.error('[auto-model] queue failed:', error))
		const timer = setInterval(tick, 1000)
		timer.unref()
		tick()
		return () => clearInterval(timer)
	}
}
