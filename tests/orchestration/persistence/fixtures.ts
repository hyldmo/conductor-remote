import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
	type FrozenWorkflowRoles,
	ORCHESTRATION_PROTOCOL_VERSION,
	type OrchestrationDb,
	type RelayIdentity
} from '../../../src/orchestration/persistence/db.ts'

export const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

export const databaseFile = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'conductor-remote-orchestration-'))
	directories.push(directory)
	return join(directory, 'orchestration.db')
}

export const roles: FrozenWorkflowRoles = {
	planning: {
		agentType: 'codex',
		model: 'GPT-5.6 Sol',
		effort: 'high',
		preamble: 'PRIVATE PLANNING PREAMBLE'
	},
	exploration: { agentType: 'claude', model: 'Claude Sonnet 4.6', effort: 'medium' },
	implementation: { agentType: 'cursor', model: 'Composer 1.5', fast: true }
}

export const relay = (instanceId: string, pid: number, processStartedAt = `start-${pid}`): RelayIdentity => ({
	instanceId,
	pid,
	processStartedAt,
	protocolVersion: ORCHESTRATION_PROTOCOL_VERSION
})

export const startExisting = (
	db: OrchestrationDb,
	overrides: Partial<Parameters<OrchestrationDb['createWorkflowRun']>[0]> = {}
) =>
	db.createWorkflowRun({
		clientId: 'start-client',
		objective: 'Build a deterministic pipeline',
		target: { kind: 'existing_session', workspaceId: 'workspace-1', sessionId: 'root-1' },
		roles,
		pristineEvidence: { durableRows: 0, outboxIds: [] },
		deliveryBaseline: { rowid: 12, outboxIds: [] },
		bootstrapPrompt: 'Inspect the orchestration boundary',
		initialEffect: {
			actionId: 'send-root',
			kind: 'send_root',
			cursor: { rowid: 12, outboxIds: [] },
			inputs: { marker: 'root-correlation' }
		},
		...overrides
	})
