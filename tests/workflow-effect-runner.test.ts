import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
	runGatedWorkflowCommand,
	type WorkflowExternalProcess,
	WorkflowGatedCommandError
} from '../src/workflow-effect-runner.ts'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function markerFile(): string {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-gated-effect-'))
	directories.push(directory)
	return join(directory, 'marker.txt')
}

const writeMarker = (file: string) => ({
	command: process.execPath,
	args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'landed')", file]
})

describe('gated Workflow child process', () => {
	test('persists an exact wrapper identity before releasing the private execution pipe', async () => {
		const marker = markerFile()
		let observed: WorkflowExternalProcess | undefined
		const result = await runGatedWorkflowCommand({
			...writeMarker(marker),
			onSpawned: async processIdentity => {
				observed = processIdentity
				expect(existsSync(marker)).toBe(false)
				expect(processIdentity.pid).toBeGreaterThan(1)
				expect(processIdentity.processGroup).toBe(processIdentity.pid)
				expect(processIdentity.processStartedAt).not.toBe('')
			}
		})

		expect(result.externalProcess).toEqual(observed)
		expect(result.code).toBe(0)
		expect(readFileSync(marker, 'utf8')).toBe('landed')
	})

	test('pipe EOF prevents execution when durable process registration fails', async () => {
		const marker = markerFile()
		const failure = await runGatedWorkflowCommand({
			...writeMarker(marker),
			onSpawned: async () => {
				throw new Error('database unavailable')
			}
		}).catch(error => error)

		expect(failure).toBeInstanceOf(WorkflowGatedCommandError)
		expect(failure).toMatchObject({ code: 'gate_rejected', phase: 'before_gate', mayHaveExecuted: false })
		expect(existsSync(marker)).toBe(false)
	})

	test('a deadline during identity lookup never registers or releases the command', async () => {
		const marker = markerFile()
		let registered = false
		const failure = await runGatedWorkflowCommand({
			...writeMarker(marker),
			timeoutMs: 10,
			readProcessStartedAt: async () => {
				await new Promise(resolve => setTimeout(resolve, 30))
				return 'synthetic start'
			},
			onSpawned: async () => {
				registered = true
			}
		}).catch(error => error)

		expect(failure).toBeInstanceOf(WorkflowGatedCommandError)
		expect(failure).toMatchObject({ code: 'timed_out', phase: 'before_gate', mayHaveExecuted: false })
		expect(registered).toBe(false)
		expect(existsSync(marker)).toBe(false)
	})

	test('a timeout after gate release kills the recorded process group and remains ambiguous', async () => {
		let external: WorkflowExternalProcess | undefined
		const failure = await runGatedWorkflowCommand({
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
			timeoutMs: 100,
			killGraceMs: 50,
			onSpawned: async identity => {
				external = identity
			}
		}).catch(error => error)

		expect(failure).toBeInstanceOf(WorkflowGatedCommandError)
		expect(failure).toMatchObject({ code: 'timed_out', phase: 'after_gate', mayHaveExecuted: true })
		if (!external) throw new Error('wrapper identity was not captured')
		const recorded = external as WorkflowExternalProcess
		expect(() => process.kill(recorded.pid, 0)).toThrow()
	})

	test('a timeout escalates when the target ignores SIGTERM', async () => {
		const started = Date.now()
		const failure = await runGatedWorkflowCommand({
			command: process.execPath,
			args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
			timeoutMs: 100,
			killGraceMs: 50,
			onSpawned: async () => {}
		}).catch(error => error)

		expect(failure).toBeInstanceOf(WorkflowGatedCommandError)
		expect(failure).toMatchObject({ code: 'timed_out', phase: 'after_gate', mayHaveExecuted: true })
		expect(failure.stdout).toContain('ready')
		expect(Date.now() - started).toBeLessThan(2_000)
	})
})
