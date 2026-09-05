import type { OrchestrationDb, RelayIdentity } from '../persistence/db.ts'
import { adopt, cancel, complete, delegate, replay, retry } from './commands.ts'
import { start } from './start.ts'
import { ownsSession, projection, projections, runIdsNeedingWake, workflowForSession } from './state.ts'
import type { WorkflowContext, WorkflowCoordinatorDeps } from './types.ts'
import { wake } from './wake.ts'

export { WorkflowCoordinatorError } from './errors.ts'
export { workflowEffectCorrelationMarker } from './helpers.ts'
export * from './types.ts'

type OperationArgs<Operation> = Operation extends (context: WorkflowContext, ...args: infer Args) => unknown
	? Args
	: never

/** Owns one wake map and the shared dependencies for every run lifecycle. */
export class WorkflowCoordinator {
	private readonly context: WorkflowContext
	constructor(db: OrchestrationDb, relay: RelayIdentity, deps: WorkflowCoordinatorDeps) {
		this.context = { db, relay, deps, waking: new Map() }
		db.registerRelayInstance({ ...relay, canDriveUi: true })
	}
	start = (...args: OperationArgs<typeof start>) => start(this.context, ...args)

	wake = (...args: OperationArgs<typeof wake>) => wake(this.context, ...args)

	delegate = (...args: OperationArgs<typeof delegate>) => delegate(this.context, ...args)

	retry = (...args: OperationArgs<typeof retry>) => retry(this.context, ...args)

	adopt = (...args: OperationArgs<typeof adopt>) => adopt(this.context, ...args)

	replay = (...args: OperationArgs<typeof replay>) => replay(this.context, ...args)

	complete = (...args: OperationArgs<typeof complete>) => complete(this.context, ...args)

	cancel = (...args: OperationArgs<typeof cancel>) => cancel(this.context, ...args)

	projection = (...args: OperationArgs<typeof projection>) => projection(this.context, ...args)

	projections = (...args: OperationArgs<typeof projections>) => projections(this.context, ...args)

	runIdsNeedingWake = (...args: OperationArgs<typeof runIdsNeedingWake>) => runIdsNeedingWake(this.context, ...args)

	workflowForSession = (...args: OperationArgs<typeof workflowForSession>) => workflowForSession(this.context, ...args)

	ownsSession = (...args: OperationArgs<typeof ownsSession>) => ownsSession(this.context, ...args)
}
