/** Persisted, exact-text, one-use authorization for a voice dispatch. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PREVIEW_TTL_MS = 2 * 60 * 1000

export interface SendPreview {
	callId: string
	workspaceId: string
	sessionId: string
	text: string
	token: string
	createdAt: number
	expiresAt: number
	status: 'ready' | 'claimed'
}

export type PreviewRefusal =
	| 'expired'
	| 'foreign-call'
	| 'foreign-session'
	| 'text-mismatch'
	| 'already-used'
	| 'unknown'

interface CreatePreview {
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

export class PreviewStore {
	readonly file: string
	private readonly now: () => number
	private previews: SendPreview[] | null = null

	constructor(file: string, deps: { now?: () => number } = {}) {
		this.file = file
		this.now = deps.now ?? Date.now
	}

	private read(): SendPreview[] {
		if (this.previews) return this.previews
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
			this.previews = Array.isArray(parsed) ? (parsed as SendPreview[]) : []
		} catch {
			this.previews = []
		}
		return this.previews
	}

	private write(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		fs.writeFileSync(this.file, `${JSON.stringify(this.read(), null, 2)}\n`, { mode: 0o600 })
		fs.chmodSync(this.file, 0o600)
	}

	create(input: CreatePreview): SendPreview {
		const createdAt = this.now()
		const preview: SendPreview = {
			...input,
			token: crypto.randomBytes(18).toString('base64url'),
			createdAt,
			expiresAt: createdAt + PREVIEW_TTL_MS,
			status: 'ready'
		}
		// Keep enough history to return an explicit `expired` refusal until the next
		// preview, then bound this append-only credential file as calls accumulate.
		this.previews = this.read().filter(candidate => candidate.expiresAt >= createdAt)
		this.previews.push(preview)
		this.write()
		return preview
	}

	claim(
		token: string,
		input: ClaimPreview
	): { ok: true; preview: SendPreview } | { ok: false; reason: PreviewRefusal } {
		const preview = this.read().find(candidate => candidate.token === token)
		if (!preview) return { ok: false, reason: 'unknown' }
		if (this.now() > preview.expiresAt) return { ok: false, reason: 'expired' }
		if (preview.status !== 'ready') return { ok: false, reason: 'already-used' }
		if (preview.callId !== input.callId) return { ok: false, reason: 'foreign-call' }
		if (preview.sessionId !== input.sessionId) return { ok: false, reason: 'foreign-session' }
		if (preview.text !== input.text) return { ok: false, reason: 'text-mismatch' }
		// Persist the claim before any caller starts an async UI delivery. A crash can lose a
		// send, but cannot replay one whose outcome became unknowable.
		preview.status = 'claimed'
		this.write()
		return { ok: true, preview: { ...preview } }
	}
}
