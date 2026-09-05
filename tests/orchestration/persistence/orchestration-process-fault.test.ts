import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { OrchestrationDb } from '../../../src/orchestration/persistence/db.ts'
import { ORCHESTRATION_PROTOCOL_VERSION, type ProcessIdentity } from '../../../src/orchestration/persistence/types.ts'

const directories: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()

afterEach(() => {
	for (const child of children) {
		try {
			child.kill('SIGKILL')
		} catch {
			// It already exited.
		}
	}
	children.clear()
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const databaseFile = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-orchestration-process-'))
	directories.push(directory)
	return join(directory, 'orchestration.db')
}

const firstLine = (child: ChildProcessWithoutNullStreams): Promise<string> =>
	new Promise((resolve, reject) => {
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => {
			stdout += String(chunk)
			const newline = stdout.indexOf('\n')
			if (newline >= 0) resolve(stdout.slice(0, newline))
		})
		child.stderr.on('data', chunk => {
			stderr += String(chunk)
		})
		child.once('exit', code => reject(new Error(`lease owner exited early (${code}): ${stderr}`)))
	})

const exactProcessAlive = (identity: ProcessIdentity): boolean => {
	if (identity.processStartedAt !== `spawned-${identity.pid}`) return false
	try {
		process.kill(identity.pid, 0)
		return true
	} catch {
		return false
	}
}

describe('orchestration process fault boundary', () => {
	test('concurrent relay startups join the same forward-only migration', async () => {
		const file = databaseFile()
		const moduleUrl = new URL('../../../src/orchestration/persistence/db.ts', import.meta.url).href
		const startAt = Date.now() + 150
		const script = `
			import { OrchestrationDb } from ${JSON.stringify(moduleUrl)};
			await new Promise(resolve => setTimeout(resolve, Math.max(0, ${startAt} - Date.now())));
			const db = new OrchestrationDb(${JSON.stringify(file)});
			if (!db.writable || db.schemaVersion !== 1) throw new Error('migration did not converge');
			db.close();
		`
		const runs = Array.from({ length: 4 }, () => {
			const child = spawn(
				process.execPath,
				['--no-warnings', '--experimental-transform-types', '--input-type=module', '--eval', script],
				{ stdio: ['pipe', 'pipe', 'pipe'] }
			)
			children.add(child)
			return new Promise<void>((resolve, reject) => {
				let stderr = ''
				child.stderr.on('data', chunk => {
					stderr += String(chunk)
				})
				child.once('exit', code => {
					children.delete(child)
					if (code === 0) resolve()
					else reject(new Error(`migration child exited ${code}: ${stderr}`))
				})
			})
		})
		await Promise.all(runs)

		const db = new OrchestrationDb(file)
		expect(db).toMatchObject({ writable: true, schemaVersion: 1 })
		db.close()
	})

	test('a paused owner is never stolen, then its post-dispatch crash creates persistent quarantine', async () => {
		const file = databaseFile()
		const moduleUrl = new URL('../../../src/orchestration/persistence/db.ts', import.meta.url).href
		const script = `
			import { OrchestrationDb, ORCHESTRATION_PROTOCOL_VERSION } from ${JSON.stringify(moduleUrl)};
			const db = new OrchestrationDb(${JSON.stringify(file)}, { processProbe: () => true });
			const owner = {
				instanceId: 'spawned-owner',
				pid: process.pid,
				processStartedAt: 'spawned-' + process.pid,
				protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
			};
			db.registerRelayInstance(owner);
			const result = db.acquireUiLease({
				owner,
				actionId: 'spawned-effect',
				effectId: 'effect-spawned',
				deadlineAt: 1,
				priority: 'background',
				nonce: 'spawned-nonce'
			});
			if (result.status !== 'acquired') throw new Error('child failed to acquire lease');
			if (!db.markUiLeaseMayExecute(result.lease)) throw new Error('child failed to mark dispatch');
			process.stdout.write(JSON.stringify(owner) + '\\n', () => process.kill(process.pid, 'SIGSTOP'));
			setInterval(() => {}, 1000);
		`
		const child = spawn(
			process.execPath,
			['--no-warnings', '--experimental-transform-types', '--input-type=module', '--eval', script],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		)
		children.add(child)
		const owner = JSON.parse(await firstLine(child)) as {
			instanceId: string
			pid: number
			processStartedAt: string
			protocolVersion: number
		}

		const contender = {
			instanceId: 'parent-contender',
			pid: process.pid,
			processStartedAt: `parent-${process.pid}`,
			protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
		}
		const db = new OrchestrationDb(file, { processProbe: exactProcessAlive })
		db.registerRelayInstance(contender)
		expect(
			db.acquireUiLease({
				owner: contender,
				actionId: 'must-wait',
				deadlineAt: 2,
				priority: 'interactive'
			})
		).toMatchObject({
			status: 'busy',
			reason: 'owner_alive',
			owner: { instanceId: owner.instanceId, nonce: 'spawned-nonce', deadlineAt: 1 }
		})

		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
		child.kill('SIGKILL')
		await exited
		children.delete(child)
		const quarantined = db.acquireUiLease({
			owner: contender,
			actionId: 'must-not-run',
			deadlineAt: 3,
			priority: 'background'
		})
		expect(quarantined).toMatchObject({
			status: 'quarantined',
			quarantine: { active: true, actionId: 'spawned-effect', effectId: 'effect-spawned' }
		})
		db.close()

		const restarted = new OrchestrationDb(file, { processProbe: exactProcessAlive })
		expect(restarted.getUiLeaseOwner()).toBeUndefined()
		expect(restarted.getUiQuarantine()).toMatchObject({
			active: true,
			actionId: 'spawned-effect',
			effectId: 'effect-spawned',
			owner: { pid: owner.pid, processStartedAt: owner.processStartedAt }
		})
		restarted.close()
	})
})
