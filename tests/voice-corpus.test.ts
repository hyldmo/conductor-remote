/**
 * Optional acceptance check against the Mac's real, read-only Conductor corpus.
 * CI and contributor machines without Conductor skip it; this workstation keeps the
 * briefing's latency and caps honest as the chat history grows.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDb } from '../src/db.ts'
import { Reads } from '../src/reads.ts'
import { VoiceBriefBoard } from '../src/voice/brief.ts'

const dbPath =
	process.env.CONDUCTOR_DB ??
	path.join(os.homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
const workspacesRoot = process.env.CONDUCTOR_WORKSPACES ?? path.join(os.homedir(), 'conductor', 'workspaces')

describe.skipIf(!fs.existsSync(dbPath))('the live voice corpus', () => {
	it('builds a bounded call board inside the phone latency budget', async () => {
		const reads = new Reads(new ConductorDb(dbPath), workspacesRoot)
		const board = new VoiceBriefBoard({
			reads,
			locked: async () => false,
			readPrefs: () => ({ readMarks: {}, drafts: {} }),
			writePrefs: () => ({ readMarks: {}, drafts: {} })
		})
		const started = performance.now()
		const roll = await board.rollCall()
		const elapsed = performance.now() - started
		const overviewStarted = performance.now()
		const overview = await board.workspaceOverview()
		const overviewElapsed = performance.now() - overviewStarted

		expect(elapsed).toBeLessThan(250)
		expect(overviewElapsed).toBeLessThan(250)
		expect(roll.spoken.length).toBeLessThanOrEqual(600)
		expect(overview.spoken.length).toBeLessThanOrEqual(700)
		expect(overview.workspaces.length).toBeLessThanOrEqual(3)
		expect(roll.queue.length).toBeLessThanOrEqual(reads.listSessionStates().length)
		for (let cursor = 0; cursor < roll.queue.length; cursor++) {
			const decision = await board.nextDecision(cursor)
			expect(decision?.spoken.length).toBeLessThanOrEqual(400)
		}
	})
})
