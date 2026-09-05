import type { VoiceHistoryCall } from '../types.ts'
import { voiceToolLabel } from './connection.ts'

/** Plain text is useful in a new agent prompt as well as in an exported file. */
export function voiceTranscriptText(call: VoiceHistoryCall): string {
	const lines = [
		`Fleet call — ${new Date(call.startedAt).toLocaleString()}`,
		`Call: ${call.callId}`,
		`Status: ${call.status}`,
		...(call.hasGaps ? ['This transcript may have gaps because the connection was interrupted.'] : []),
		...(call.captureError ? [call.captureError] : [])
	]
	for (const entry of call.entries) {
		const role = entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Orchestrator' : 'Activity'
		const text = entry.role === 'tool' ? voiceToolLabel(entry.text) : entry.text
		lines.push('', `${role} · ${new Date(entry.at).toLocaleTimeString()}`, text)
		if (entry.transcriptionFailed) lines.push('[Audio could not be transcribed.]')
		else if (entry.partial) lines.push('[Partial transcript.]')
		if (entry.interrupted) lines.push('[Reply interrupted. Generated text may include words that were not played.]')
	}
	return `${lines.join('\n')}\n`
}
