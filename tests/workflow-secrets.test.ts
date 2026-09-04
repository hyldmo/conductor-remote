import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SearchIndex } from '../src/search.ts'
import {
	scrubWorkflowSecrets,
	WORKFLOW_PRIVATE_ENVELOPE_OPEN,
	workflowCapabilityToken,
	workflowPrivateEnvelope
} from '../src/shared.ts'
import { parseMessage, parseOutboxMessage, renderTranscript } from '../src/transcript.ts'

const capability = workflowCapabilityToken('Q'.repeat(43))
const envelope = workflowPrivateEnvelope({
	workflowId: 'workflowsecretxyz',
	phaseCapability: capability,
	cycle: 2,
	revision: 4,
	allowedRoles: ['implementation']
})

const row = (content: string, rowid = 1) => ({
	rowid,
	id: `message-${rowid}`,
	role: 'user',
	content,
	full_message: null,
	created_at: '2026-09-04 10:00:00',
	sent_at: '2026-09-04 10:00:00',
	queue_order: null
})

describe('Workflow secret scrubber', () => {
	test('removes complete, unterminated, and loose capability material', () => {
		const complete = scrubWorkflowSecrets(`before\n${envelope}\nafter ${capability}`)
		expect(complete).toContain('before')
		expect(complete).toContain('after')
		expect(complete).not.toContain(capability)
		expect(complete).not.toContain('workflowsecretxyz')

		const truncated = scrubWorkflowSecrets(`safe\n${WORKFLOW_PRIVATE_ENVELOPE_OPEN}\n${capability}\nunsafe`)
		expect(truncated).toContain('safe')
		expect(truncated).not.toContain('unsafe')
		expect(truncated).not.toContain(capability)

		const punctuationEnding = `crwf_v1_${'A'.repeat(42)}-`
		expect(scrubWorkflowSecrets(`before ${punctuationEnding} after`)).toBe('before [Workflow capability hidden] after')
	})

	test('scrubs user rows and queued outbox payloads before they become entries', () => {
		const [entry] = parseMessage(row(`Visible objective\n${envelope}\n${capability}`))
		const queued = parseOutboxMessage({
			message_id: 'queued-1',
			delivery_payload: JSON.stringify({ message: `${envelope}\nQueued objective ${capability}` }),
			created_at: '2026-09-04 10:00:01'
		})
		const exposed = JSON.stringify([entry, queued])

		expect(exposed).toContain('Visible objective')
		expect(exposed).toContain('Queued objective')
		expect(exposed).not.toContain(capability)
		expect(exposed).not.toContain('workflowsecretxyz')
	})

	test('scrubs assistant prose, thinking, rendered tool arguments, and tool output', () => {
		const content = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: `Prose ${envelope}` },
					{ type: 'thinking', thinking: `Reasoning ${capability}` },
					{
						type: 'tool_use',
						name: 'delegate_task',
						id: 'tool-1',
						input: { description: 'Delegate safely', command: `phase_capability=${capability}` }
					},
					{ type: 'tool_result', tool_use_id: 'tool-1', content: `error echoed ${capability}`, is_error: true }
				]
			}
		})
		const entries = parseMessage(row(content))
		const rendered = renderTranscript(entries, { thinking: true, tools: true }).text
		const exposed = `${JSON.stringify(entries)}\n${rendered}`

		expect(exposed).toContain('Prose')
		expect(exposed).toContain('Delegate safely')
		expect(exposed).not.toContain(capability)
		expect(exposed).not.toContain('workflowsecretxyz')
	})
})

describe('Workflow secrets in transcript search', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-workflow-search-'))
	const sourceFile = path.join(dir, 'source.db')
	const source = new DatabaseSync(sourceFile)
	source.exec(`
		CREATE TABLE session_messages (
			id TEXT NOT NULL,
			session_id TEXT,
			role TEXT,
			content TEXT,
			full_message TEXT,
			created_at TEXT NOT NULL,
			sent_at TEXT,
			queue_order INTEGER
		)
	`)
	source
		.prepare(`
			INSERT INTO session_messages (
				id, session_id, role, content, full_message, created_at, sent_at, queue_order
			) VALUES (?, ?, 'user', ?, NULL, '2026-09-04 10:00:00', '2026-09-04 10:00:00', NULL)
		`)
		.run('message-1', 'chat-1', `${envelope}\nVisible lighthouse objective`)
	source.close()
	const index = new SearchIndex(sourceFile, path.join(dir, 'search.db'))

	beforeAll(async () => {
		index.start()
		const deadline = Date.now() + 5000
		while (!index.status().ready) {
			if (Date.now() > deadline) throw new Error('search index never caught up')
			await new Promise(resolve => setTimeout(resolve, 10))
		}
	})

	afterAll(async () => {
		await index.stop()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	test('indexes visible objective text but no private envelope fields', async () => {
		expect(await index.search('lighthouse')).toHaveLength(1)
		expect(await index.search('workflowsecretxyz')).toEqual([])
		expect(await index.search('phase_capability')).toEqual([])
		expect(await index.search('crwf_v1')).toEqual([])
	})
})
