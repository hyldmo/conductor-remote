/** Shared, bounded terminal diagnostics; never stores arbitrary provider error messages. */
export interface VoiceResponseOutcome {
	id?: string
	status?: string
	reason?: string
	code?: string
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function label(value: unknown): string | undefined {
	return typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) : undefined
}
export function voiceResponseOutcome(value: unknown): VoiceResponseOutcome {
	const response = object(value)
	const details = object(response.status_details)
	const error = object(details.error)
	return {
		id: label(response.id),
		status: label(response.status),
		reason: label(details.reason),
		code: label(error.code ?? error.type)
	}
}
export function voiceResponseError(value: unknown): string | undefined {
	const outcome = voiceResponseOutcome(value)
	if (outcome.status !== 'failed' && outcome.status !== 'incomplete') return undefined
	return `The answer ${outcome.status === 'failed' ? 'failed' : 'was incomplete'}${outcome.code || outcome.reason ? ` (${outcome.code ?? outcome.reason})` : ''}. Check action receipts before retrying.`
}
