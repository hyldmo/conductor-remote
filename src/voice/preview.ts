/** Persisted, exact-text, one-use authorization for a voice dispatch. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PREVIEW_TTL_MS = 2 * 60 * 1000

interface PreviewBase {
	callId: string
	token: string
	createdAt: number
	expiresAt: number
	status: 'ready' | 'claimed' | 'superseded'
	presented?: boolean
	reviewPaused?: boolean
	targetLabel?: string
	outcome?: { state: 'running' | 'completed' | 'parked' | 'failed' | 'unknown'; workspaceId?: string; message?: string }
}

export interface SendPreview extends PreviewBase {
	kind: 'send_prompt'
	workspaceId: string
	sessionId: string
	text: string
}

export interface WorkspacePreview extends PreviewBase {
	kind: 'create_workspace'
	repo: string
	prompt: string
}

export type VoicePreview = SendPreview | WorkspacePreview

export type PreviewRefusal =
	| 'expired'
	| 'foreign-call'
	| 'foreign-session'
	| 'foreign-repo'
	| 'text-mismatch'
	| 'prompt-mismatch'
	| 'wrong-action'
	| 'already-used'
	| 'unknown'
	| 'editing'

interface CreatePreview {
	targetLabel?: string
	callId: string
	workspaceId: string
	sessionId: string
	text: string
}

interface ClaimPreview {
	callId: string
	sessionId: string
	text: string
}

interface CreateWorkspacePreview {
	callId: string
	repo: string
	prompt: string
}

interface ClaimWorkspacePreview {
	callId: string
	repo: string
	prompt: string
}

export class PreviewStore {
	readonly file: string
	private readonly now: () => number
	private previews: VoicePreview[] | null = null
	private presentations = new Map<string, (shown: boolean) => void>()

	constructor(file: string, deps: { now?: () => number } = {}) {
		this.file = file
		this.now = deps.now ?? Date.now
	}

	private read(): VoicePreview[] {
		if (this.previews) return this.previews
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
			this.previews = Array.isArray(parsed)
				? (parsed as Array<VoicePreview | (Omit<SendPreview, 'kind'> & { kind?: undefined })>).map(preview =>
						preview.kind ? preview : { ...preview, kind: 'send_prompt' }
					)
				: []
			// A previous process may have dispatched before it lost the receipt.
			let recovered = false
			for (const preview of this.previews) {
				if (preview.status === 'claimed' && (!preview.outcome || preview.outcome.state === 'running')) {
					preview.outcome = {
						state: 'unknown',
						message: 'The relay restarted before saving the receipt. Check the destination before retrying.'
					}
					recovered = true
				}
			}
			if (recovered) this.write()
		} catch {
			this.previews = []
		}
		return this.previews
	}

	private write(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		const temporary = `${this.file}.tmp`
		fs.writeFileSync(temporary, `${JSON.stringify(this.read(), null, 2)}\n`, { mode: 0o600 })
		fs.renameSync(temporary, this.file)
		fs.chmodSync(this.file, 0o600)
	}

	create(input: CreatePreview): SendPreview {
		const createdAt = this.now()
		const preview: SendPreview = {
			...input,
			kind: 'send_prompt',
			token: crypto.randomBytes(18).toString('base64url'),
			createdAt,
			expiresAt: createdAt + PREVIEW_TTL_MS,
			status: 'ready'
		}
		// Keep enough history to return an explicit `expired` refusal until the next
		// preview, then bound this append-only credential file as calls accumulate.
		this.retire(input.callId, createdAt)
		this.read().push(preview)
		this.write()
		return preview
	}

	createWorkspace(input: CreateWorkspacePreview): WorkspacePreview {
		const createdAt = this.now()
		const preview: WorkspacePreview = {
			...input,
			kind: 'create_workspace',
			token: crypto.randomBytes(18).toString('base64url'),
			createdAt,
			expiresAt: createdAt + PREVIEW_TTL_MS,
			status: 'ready'
		}
		this.retire(input.callId, createdAt)
		this.read().push(preview)
		this.write()
		return preview
	}

	private retire(callId: string, now: number): void {
		// Expiry revokes approval, not the review content or its receipt. Keep 30 days.
		this.previews = this.read().filter(candidate => candidate.createdAt >= now - 30 * 86_400_000)
		for (const preview of this.previews) {
			if (preview.callId === callId && preview.status === 'ready') preview.status = 'superseded'
		}
	}

	list(callId: string): VoicePreview[] {
		return this.read()
			.filter(preview => preview.callId === callId)
			.map(preview => structuredClone(preview))
	}

	get(callId: string, token: string): VoicePreview | undefined {
		return this.list(callId).find(preview => preview.token === token)
	}

	present(callId: string, token: string): boolean {
		const preview = this.read().find(candidate => candidate.callId === callId && candidate.token === token)
		if (preview?.status !== 'ready') return false
		preview.presented = true
		this.write()
		this.presentations.get(token)?.(true)
		return true
	}

	waitForPresentation(token: string, timeoutMs = 1800): Promise<boolean> {
		if (this.read().find(preview => preview.token === token)?.presented) return Promise.resolve(true)
		return new Promise(resolve => {
			const finish = (shown: boolean) => {
				clearTimeout(timer)
				this.presentations.delete(token)
				resolve(shown)
			}
			const timer = setTimeout(() => finish(false), timeoutMs)
			this.presentations.set(token, finish)
		})
	}

	settle(token: string, outcome: NonNullable<VoicePreview['outcome']>): void {
		const preview = this.read().find(candidate => candidate.token === token)
		if (preview?.status !== 'claimed') return
		preview.outcome = outcome
		this.write()
	}

	edit(callId: string, token: string, text: string): VoicePreview | null {
		const preview = this.get(callId, token)
		if (preview?.status !== 'ready') return null
		return preview.kind === 'send_prompt'
			? this.create({
					callId,
					workspaceId: preview.workspaceId,
					sessionId: preview.sessionId,
					targetLabel: preview.targetLabel,
					text
				})
			: this.createWorkspace({ callId, repo: preview.repo, prompt: text })
	}

	pauseReview(callId: string, token: string, paused: boolean): boolean {
		const preview = this.read().find(preview => preview.callId === callId && preview.token === token)
		if (preview?.status !== 'ready') return false
		preview.reviewPaused = paused
		this.write()
		return true
	}

	private available(
		token: string,
		callId: string
	): { ok: true; preview: VoicePreview } | { ok: false; reason: PreviewRefusal } {
		const preview = this.read().find(candidate => candidate.token === token)
		if (!preview) return { ok: false, reason: 'unknown' }
		if (this.now() > preview.expiresAt) return { ok: false, reason: 'expired' }
		if (preview.status !== 'ready') return { ok: false, reason: 'already-used' }
		if (preview.callId !== callId) return { ok: false, reason: 'foreign-call' }
		if (preview.reviewPaused) return { ok: false, reason: 'editing' }
		return { ok: true, preview }
	}

	private markClaimed<T extends VoicePreview>(preview: T): T {
		preview.status = 'claimed'
		preview.outcome = { state: 'running' }
		this.write()
		return { ...preview }
	}

	claim(
		token: string,
		input: ClaimPreview
	): { ok: true; preview: SendPreview } | { ok: false; reason: PreviewRefusal } {
		const found = this.available(token, input.callId)
		if (!found.ok) return found
		const preview = found.preview
		if (preview.kind !== 'send_prompt') return { ok: false, reason: 'wrong-action' }
		if (preview.sessionId !== input.sessionId) return { ok: false, reason: 'foreign-session' }
		if (preview.text !== input.text) return { ok: false, reason: 'text-mismatch' }
		// Persist the claim before any caller starts an async UI delivery. A crash can lose a
		// send, but cannot replay one whose outcome became unknowable.
		return { ok: true, preview: this.markClaimed(preview) }
	}

	claimWorkspace(
		token: string,
		input: ClaimWorkspacePreview
	): { ok: true; preview: WorkspacePreview } | { ok: false; reason: PreviewRefusal } {
		const found = this.available(token, input.callId)
		if (!found.ok) return found
		const preview = found.preview
		if (preview.kind !== 'create_workspace') return { ok: false, reason: 'wrong-action' }
		if (preview.repo !== input.repo) return { ok: false, reason: 'foreign-repo' }
		if (preview.prompt !== input.prompt) return { ok: false, reason: 'prompt-mismatch' }
		return { ok: true, preview: this.markClaimed(preview) }
	}
}
