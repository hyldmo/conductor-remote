import { describe, expect, test } from 'vitest'
import {
	assertWorkflowDelegation,
	phaseAfterDeliveredBaton,
	type WorkflowCapabilityClaims,
	WorkflowGuardError,
	type WorkflowGuardJob,
	type WorkflowGuardRun,
	workflowDelegationTransition,
	workflowExplorationBarrierSatisfied
} from '../../../src/orchestration/workflow/machine.ts'

const run = (phase: WorkflowGuardRun['phase'] = 'planning'): WorkflowGuardRun => ({
	id: 'wf-1',
	rootSessionId: 'root-1',
	phase,
	cycle: 2,
	revision: 3
})

const capability = (phase: WorkflowCapabilityClaims['phase'] = 'planning'): WorkflowCapabilityClaims => ({
	runId: 'wf-1',
	rootSessionId: 'root-1',
	cycle: 2,
	revision: 3,
	phase,
	allowedRoles: ['exploration', 'implementation'],
	consumed: false,
	revoked: false
})

const explorer = (receipt: 'outbox' | 'message' = 'message'): WorkflowGuardJob => ({
	role: 'exploration',
	cycle: 2,
	status: 'returned',
	batonReceiptKind: receipt
})

describe('Workflow phase guards', () => {
	test('requires a UI-authorized run and its exact root', () => {
		expect(() => assertWorkflowDelegation(null, null, { sessionId: 'root-1', role: 'exploration' }, [])).toThrow(
			/workflow/i
		)
		try {
			assertWorkflowDelegation(run(), capability(), { sessionId: 'another-chat', role: 'implementation' }, [explorer()])
		} catch (error) {
			expect(error).toBeInstanceOf(WorkflowGuardError)
			expect((error as WorkflowGuardError).status).toBe(403)
			expect((error as WorkflowGuardError).code).toBe('workflow_authorization_failed')
		}
	})

	test('rejects stale, consumed, wrong-phase, and blocked capabilities', () => {
		expect(() =>
			assertWorkflowDelegation(
				run(),
				{ ...capability(), consumed: true },
				{ sessionId: 'root-1', role: 'implementation' },
				[explorer()]
			)
		).toThrow(/consumed/i)
		expect(() =>
			assertWorkflowDelegation(
				run(),
				{ ...capability(), revision: 2 },
				{ sessionId: 'root-1', role: 'implementation' },
				[explorer()]
			)
		).toThrow(/stale/i)
		expect(() =>
			assertWorkflowDelegation(run('exploring'), capability(), { sessionId: 'root-1', role: 'implementation' }, [])
		).toThrow(/stale|permit/i)
		expect(() =>
			assertWorkflowDelegation(run('blocked'), capability(), { sessionId: 'root-1', role: 'implementation' }, [])
		).toThrow(/recovery/i)
	})

	test('does not treat an accepted Baton as delivered evidence', () => {
		expect(workflowExplorationBarrierSatisfied([explorer('outbox')], 2)).toBe(false)
		expect(() =>
			assertWorkflowDelegation(run(), capability(), { sessionId: 'root-1', role: 'implementation' }, [
				explorer('outbox')
			])
		).toThrow(/Baton is delivered/i)
	})

	test('allows implementation only after all explorer Batons are delivered', () => {
		const jobs = [explorer(), explorer()]
		expect(() =>
			assertWorkflowDelegation(run(), capability(), { sessionId: 'root-1', role: 'implementation' }, jobs)
		).not.toThrow()
		expect(workflowDelegationTransition(run(), 'implementation')).toEqual({
			phase: 'implementing',
			cycle: 2,
			revision: 4,
			logicalPrefix: 'implement'
		})
	})

	test('rotates revision for extra explorers and cycle when review reopens exploration', () => {
		const exploring = { ...run('exploring'), revision: 1 }
		const exploringCapability = {
			...capability('exploring'),
			revision: 1,
			allowedRoles: ['exploration'] as const
		}
		expect(() =>
			assertWorkflowDelegation(
				exploring,
				{ ...exploringCapability, allowedRoles: [...exploringCapability.allowedRoles] },
				{ sessionId: 'root-1', role: 'exploration' },
				[{ role: 'exploration', cycle: 2, status: 'running' }]
			)
		).not.toThrow()
		expect(workflowDelegationTransition(exploring, 'exploration')).toEqual({
			phase: 'exploring',
			cycle: 2,
			revision: 2,
			logicalPrefix: 'explore'
		})
		expect(workflowDelegationTransition(run('reviewing'), 'exploration')).toEqual({
			phase: 'exploring',
			cycle: 3,
			revision: 0,
			logicalPrefix: 'explore'
		})
	})

	test('opens phases only on the final delivered Baton', () => {
		const waiting: WorkflowGuardJob[] = [explorer(), { role: 'exploration', cycle: 2, status: 'running' }]
		expect(phaseAfterDeliveredBaton('exploration', waiting, 2)).toBeNull()
		waiting[1] = explorer()
		expect(phaseAfterDeliveredBaton('exploration', waiting, 2)).toBe('planning')

		const implementations: WorkflowGuardJob[] = [
			{ role: 'implementation', cycle: 2, status: 'returned', batonReceiptKind: 'outbox' }
		]
		expect(phaseAfterDeliveredBaton('implementation', implementations, 2)).toBeNull()
		implementations[0] = { ...implementations[0], batonReceiptKind: 'message' }
		expect(phaseAfterDeliveredBaton('implementation', implementations, 2)).toBe('reviewing')
	})
})
