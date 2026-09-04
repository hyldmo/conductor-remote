import { describe, expect, test } from 'vitest'
import {
	parseConfirmUiStableRequest,
	parseStartWorkflowRequest,
	parseWorkflowAdoptRequest,
	parseWorkflowDelegateRequest,
	parseWorkflowReplayRequest,
	WorkflowRequestError,
	workflowClientIsMcp
} from '../src/workflow-http.ts'

describe('Workflow HTTP contracts', () => {
	test('parses both exact start targets', () => {
		expect(
			parseStartWorkflowRequest({
				clientId: 'tap-1',
				objective: ' Build it. ',
				target: { kind: 'new_workspace', repo: 'relay', sendImmediately: true }
			})
		).toMatchObject({ objective: 'Build it.', target: { kind: 'new_workspace', repo: 'relay' } })
		expect(
			parseStartWorkflowRequest({
				clientId: 'tap-2',
				objective: 'Investigate',
				target: { kind: 'existing_session', workspaceId: 'ws-1', sessionId: 'chat-1' }
			})
		).toMatchObject({ target: { kind: 'existing_session', sessionId: 'chat-1' } })
	})

	test('rejects unknown start fields instead of accepting legacy Workflow intake', () => {
		expect(() =>
			parseStartWorkflowRequest({
				clientId: 'tap-1',
				objective: 'Build it',
				target: { kind: 'new_workspace', repo: 'relay', sendImmediately: true },
				model: 'anything'
			})
		).toThrow(/unknown field model/i)
	})

	test('requires the strict capability-scoped delegation body and matching route', () => {
		const body = {
			workflow_id: 'wf-1',
			phase_capability: 'wfcap_secret',
			session_id: 'root-1',
			role: 'exploration',
			prompt: 'Map the API'
		}
		expect(parseWorkflowDelegateRequest(body, 'wf-1')).toEqual(body)
		expect(() => parseWorkflowDelegateRequest({ ...body, workflow_id: 'wf-2' }, 'wf-1')).toThrow(WorkflowRequestError)
		expect(() => parseWorkflowDelegateRequest({ ...body, model: 'override' }, 'wf-1')).toThrow(/unknown field/i)
	})

	test('keeps risky replay and adoption explicit', () => {
		expect(() =>
			parseWorkflowReplayRequest({ clientId: 'tap-1', actionId: 'open:1', confirmDuplicateRisk: false })
		).toThrow(/must be true/i)
		expect(() =>
			parseWorkflowAdoptRequest({
				clientId: 'tap-1',
				actionId: 'open:1',
				workspaceId: 'ws-1',
				sessionId: 'chat-1'
			})
		).toThrow(/exactly one/i)
	})

	test('requires an exact, explicit UI stability acknowledgement', () => {
		expect(parseConfirmUiStableRequest({ clientId: 'phone-1', confirmStable: true, createdAt: 42 })).toEqual({
			clientId: 'phone-1',
			confirmStable: true,
			createdAt: 42
		})
		expect(() => parseConfirmUiStableRequest({ clientId: 'phone-1', confirmStable: false, createdAt: 42 })).toThrow(
			/must be true/i
		)
		expect(() =>
			parseConfirmUiStableRequest({ clientId: 'phone-1', confirmStable: true, createdAt: 42, extra: 'effect-1' })
		).toThrow(/unknown field/i)
		expect(() => parseConfirmUiStableRequest({ clientId: 'phone-1', confirmStable: true })).toThrow(/createdAt/i)
	})

	test('recognizes the MCP boundary marker', () => {
		expect(workflowClientIsMcp({ 'x-relay-client': 'mcp' })).toBe(true)
		expect(workflowClientIsMcp({})).toBe(false)
	})
})
