const KEY = 'conductor-remote-workflow-drafts'

/** Unsent mode choices belong to their tabs. Only Send authorizes a Workflow run. */
export function loadWorkflowDrafts(): Record<string, true> {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
		if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
		return Object.fromEntries(Object.entries(saved).filter(([, active]) => active === true))
	} catch {
		return {}
	}
}

export function writeWorkflowDrafts(drafts: Record<string, true>): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(drafts))
	} catch {
		// The live choice still works when this device cannot persist it.
	}
}
