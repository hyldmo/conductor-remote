import { HIT_CLOSE, HIT_OPEN } from '../shared.ts'
import type { DevServerState, VoiceHistoryEntry, VoiceHistorySummary } from '../wire.ts'

// ── formatting ──────────────────────────────────────────────────────────────────
// Tool results are text an agent reads, so they are formatted rather than dumped as
// JSON: half the tokens, and every id an agent needs to chain the next call stays
// visible instead of buried in a nested object.

export function unmark(text: string): string {
	return text.replaceAll(HIT_OPEN, '«').replaceAll(HIT_CLOSE, '»').replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text
}

/** A true output bound: unlike `clip`, the truncation marker is inside `max`. */
function clipExact(text: string, max: number): string {
	if (text.length <= max) return text
	const suffix = '… [truncated]'
	if (max <= suffix.length) return text.slice(0, max)
	return `${text.slice(0, max - suffix.length)}${suffix}`
}

/**
 * Fit a transcript inside one MCP result without dropping either side of a nearby
 * read. Short entries keep their full text; the longest entries share what remains.
 */
export function boundedTranscript(header: string[], entries: string[], maxChars: number): string {
	const prefix = header.length ? `${header.join('\n')}\n\n` : ''
	if (!entries.length) return clipExact(prefix.trim(), maxChars)
	const separators = Math.max(0, entries.length - 1) * 2
	const available = Math.max(1, maxChars - prefix.length - separators)
	const fullLength = entries.reduce((sum, entry) => sum + entry.length, 0)
	if (fullLength <= available) return `${prefix}${entries.join('\n\n')}`

	// Find the largest per-entry ceiling whose clipped rows fit. Entries shorter than
	// it return their unused share to the longer ones, unlike a fixed equal split.
	let low = 1
	let high = Math.max(...entries.map(entry => entry.length))
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		const used = entries.reduce((sum, entry) => sum + Math.min(entry.length, mid), 0)
		if (used <= available) low = mid
		else high = mid - 1
	}
	return clipExact(`${prefix}${entries.map(entry => clipExact(entry, low)).join('\n\n')}`, maxChars)
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`
}

/** Wall-clock stamp for a log line. Null on continuation lines the file parser couldn't date. */
export function stamp(t: number | null): string {
	if (t === null) return '        '
	const d = new Date(t)
	const p = (n: number): string => String(n).padStart(2, '0')
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "in 42m" / "38m ago" — an absolute epoch is unreadable, and an agent's clock may differ. */
export function relative(at: number): string {
	const mins = Math.round((at - Date.now()) / 60_000)
	if (mins > 0) return `in ${mins}m`
	return mins < 0 ? `${-mins}m ago` : 'now'
}

/** Human-readable state that retains every exact Run-config ID and preview URL. */
export function formatDevServer(state: DevServerState, headline = state.running ? 'running' : 'stopped'): string {
	const summary = [headline]
	if (state.task) summary.push(`task ${state.task}`)
	if (state.port !== null) summary.push(`port ${state.port}`)
	if (state.forwarded) summary.push(state.url ? `forwarded ${state.url}` : 'forwarded')
	else if (state.running) summary.push('not forwarded')

	const lines = [summary.join(' · ')]
	if (state.error) lines.push(`! ${state.error}`)
	if (state.runConfigs.length) {
		lines.push(`run configs: ${state.runConfigs.map(config => `${config.id} (${config.name})`).join(', ')}`)
	}
	if (state.forwards.length) {
		lines.push('previews:')
		for (const forward of state.forwards) {
			const details = [
				`${forward.name}: port ${forward.port}`,
				forward.running ? 'running' : 'stopped',
				forward.forwarded ? (forward.url ? `forwarded ${forward.url}` : 'forwarded') : 'not forwarded'
			]
			lines.push(`- ${details.join(' · ')}`)
		}
	}
	return lines.join('\n')
}

export function voiceCallHeader(call: VoiceHistorySummary): string[] {
	return [
		`call_id: ${call.callId}`,
		`${new Date(call.startedAt).toISOString()} · ${call.status} · ${call.transport} · ${call.entryCount} entries`,
		...(call.hasGaps ? ['! This transcript may have gaps from an interrupted connection.'] : []),
		...(call.captureError ? [`! ${call.captureError}`] : [])
	]
}

export function voiceEntryFlags(
	entry: Pick<VoiceHistoryEntry, 'partial' | 'interrupted' | 'transcriptionFailed'>
): string {
	const flags = [
		...(entry.transcriptionFailed ? ['audio could not be transcribed'] : entry.partial ? ['partial transcript'] : []),
		...(entry.interrupted ? ['reply interrupted; generated text may include words not played'] : [])
	]
	return flags.length ? ` (${flags.join('; ')})` : ''
}
