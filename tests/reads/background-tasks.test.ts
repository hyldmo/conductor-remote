/**
 * The open-task fold and the process gate behind the phone's "Waiting for task" row
 * (src/reads/background-tasks.ts).
 *
 * Both ways of getting it wrong are silent. Too few and a chat that will resume itself
 * in ten minutes reads as done — the bug this was written for. Too many and a wait
 * from a process that died days ago sits at the foot of the chat with a timer that
 * never stops, which is the same lie the desktop never tells because its own list is
 * in memory and goes with the app. So the gate is pinned from both sides: a task
 * started before its process is dropped, one started after it is kept, and an abort
 * frame between the two is *not* a close, since six tasks here completed through one.
 *
 * The `ps` parser is pinned against a line copied from this Mac, because the id it
 * reads is the whole join between a process and a chat, and a regex that quietly
 * misses it shows no wait for any chat, with nothing logged on either side.
 */

import { describe, expect, test } from 'vitest'
import { openBackgroundTasks, parseAgentProcesses } from '../../src/reads/background-tasks.ts'

const started = (taskId: string, created_at: string, description = `task ${taskId}`) => ({
	created_at,
	content: JSON.stringify({
		type: 'system',
		subtype: 'task_started',
		session_id: 's',
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`,
		description,
		task_type: 'local_bash'
	})
})

const notified = (taskId: string, created_at: string, status = 'completed') => ({
	created_at,
	content: JSON.stringify({
		type: 'system',
		subtype: 'task_notification',
		status,
		task_id: taskId,
		tool_use_id: `toolu_${taskId}`
	})
})

const T0 = Date.parse('2026-09-02T10:00:00.000Z')

describe('open background tasks', () => {
	test('a started task with no notification is open, with its description and start', () => {
		const rows = [started('a', '2026-09-02T10:48:47.856Z', 'Wait until 10:52:00Z before re-enabling the schedule')]
		expect(openBackgroundTasks(rows, T0)).toEqual([
			{
				taskId: 'a',
				toolUseId: 'toolu_a',
				description: 'Wait until 10:52:00Z before re-enabling the schedule',
				taskType: 'local_bash',
				since: '2026-09-02T10:48:47.856Z'
			}
		])
	})

	test('a notification closes its own task and no other, whatever its status', () => {
		const rows = [
			started('a', '2026-09-02T10:01:00.000Z'),
			started('b', '2026-09-02T10:02:00.000Z'),
			started('c', '2026-09-02T10:03:00.000Z'),
			notified('a', '2026-09-02T10:05:00.000Z'),
			notified('c', '2026-09-02T10:06:00.000Z', 'failed')
		]
		expect(openBackgroundTasks(rows, T0).map(t => t.taskId)).toEqual(['b'])
	})

	test('a task started before its process is dead, one started after it is not', () => {
		const process = Date.parse('2026-09-02T10:05:00.000Z')
		const rows = [started('old', '2026-09-02T10:01:00.000Z'), started('new', '2026-09-02T10:06:00.000Z')]
		expect(openBackgroundTasks(rows, process).map(t => t.taskId)).toEqual(['new'])
	})

	test('an abort frame is not a close', () => {
		const rows = [
			started('a', '2026-09-02T10:01:00.000Z'),
			{ created_at: '2026-09-02T10:02:00.000Z', content: '{"type":"error","content":"aborted by user"}' }
		]
		expect(openBackgroundTasks(rows, T0).map(t => t.taskId)).toEqual(['a'])
	})

	test('frames without a task id, other system frames and unparseable rows are ignored', () => {
		const rows = [
			{ created_at: '2026-09-02T10:01:00.000Z', content: '{"type":"system","subtype":"background_tasks_changed"}' },
			{ created_at: '2026-09-02T10:01:01.000Z', content: '{"type":"system","subtype":"task_started"}' },
			{ created_at: '2026-09-02T10:01:02.000Z', content: 'not json' },
			{ created_at: '2026-09-02T10:01:03.000Z', content: '{"type":"assistant","message":{"content":[]}}' }
		]
		expect(openBackgroundTasks(rows, T0)).toEqual([])
	})

	test('a task with no description is named by its type', () => {
		const rows = [
			{
				created_at: '2026-09-02T10:01:00.000Z',
				content: '{"type":"system","subtype":"task_started","task_id":"x","task_type":"local_agent"}'
			}
		]
		expect(openBackgroundTasks(rows, 0)).toMatchObject([{ description: 'local_agent', toolUseId: null }])
	})
})

describe('agent process listing', () => {
	const line =
		'54874 Wed Sep  2 12:05:23 2026 /Users/hyldmo/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.257/claude --output-format stream-json --verbose --input-format stream-json --thinking adaptive --resume=3c2353fc-ce46-4133-a8ad-0e8d395c11b6 --disallowedTools x'

	test('reads the session id and start time off a Conductor child', () => {
		const starts = parseAgentProcesses(`${line}\n`)
		expect([...starts.keys()]).toEqual(['3c2353fc-ce46-4133-a8ad-0e8d395c11b6'])
		expect(starts.get('3c2353fc-ce46-4133-a8ad-0e8d395c11b6')).toBe(Date.parse('Wed Sep  2 12:05:23 2026'))
	})

	test('reads a space-separated flag and a fresh chat’s --session-id', () => {
		const starts = parseAgentProcesses(
			[
				'1 Wed Sep  2 12:05:23 2026 /opt/claude --resume 3c2353fc-ce46-4133-a8ad-0e8d395c11b6',
				'2 Wed Sep  2 12:05:24 2026 claude --session-id=0f111f3d-2e65-4f10-8d65-8decc5ef5d24 --verbose'
			].join('\n')
		)
		expect([...starts.keys()].sort()).toEqual([
			'0f111f3d-2e65-4f10-8d65-8decc5ef5d24',
			'3c2353fc-ce46-4133-a8ad-0e8d395c11b6'
		])
	})

	test('skips claude processes that are not a chat, and every other process', () => {
		const starts = parseAgentProcesses(
			[
				'19323 Tue Sep  1 23:39:05 2026 /Users/hyldmo/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.257/claude --chrome-native-host',
				'5401 Tue Sep  1 22:29:49 2026 /Applications/Conductor.app/Contents/MacOS/conductor',
				'9 Tue Sep  1 22:29:49 2026 /usr/bin/grep --resume=3c2353fc-ce46-4133-a8ad-0e8d395c11b6'
			].join('\n')
		)
		expect(starts.size).toBe(0)
	})

	test('two processes for one chat keep the later start', () => {
		const starts = parseAgentProcesses(
			[
				'1 Wed Sep  2 12:05:23 2026 claude --resume=3c2353fc-ce46-4133-a8ad-0e8d395c11b6',
				'2 Wed Sep  2 12:40:10 2026 claude --resume=3c2353fc-ce46-4133-a8ad-0e8d395c11b6'
			].join('\n')
		)
		expect(starts.get('3c2353fc-ce46-4133-a8ad-0e8d395c11b6')).toBe(Date.parse('Wed Sep  2 12:40:10 2026'))
	})
})
