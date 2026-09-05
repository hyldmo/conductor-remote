import { createBaseServices } from './services/base.ts'
import { createDelegationsServices } from './services/delegations.ts'
import { createDeliveryServices } from './services/delivery.ts'
import { createFilesServices } from './services/files.ts'
import { createMcpServices } from './services/mcp.ts'
import { createResponsesServices } from './services/responses.ts'
import { createVoiceServices } from './services/voice.ts'
import { createWorkflowServices } from './services/workflow.ts'
import { createWorkflowProbesServices } from './services/workflow-probes.ts'
import { createWorkflowStateServices } from './services/workflow-state.ts'

/** One construction owns every relay connection, queue, and background service. */
export function createRelayServices() {
	const base = createBaseServices()
	const responses = createResponsesServices({ ...base })
	const mcp = createMcpServices({ ...base, ...responses })
	const voice = createVoiceServices({ ...base })
	const delivery = createDeliveryServices({ ...base })
	const delegations = createDelegationsServices({ ...base, ...delivery })
	const workflowState = createWorkflowStateServices({ ...base, ...responses })
	const workflowProbes = createWorkflowProbesServices({ ...base, ...delivery })
	const workflow = createWorkflowServices({ ...base, ...workflowProbes, ...delivery, ...delegations })
	const files = createFilesServices({ ...responses, ...base })
	return {
		...base,
		...responses,
		...mcp,
		...voice,
		...delivery,
		...delegations,
		...workflowState,
		...workflowProbes,
		...workflow,
		...files
	}
}
export type RelayServices = ReturnType<typeof createRelayServices>
