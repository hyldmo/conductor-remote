export type NewWorkspaceRepoStatus = 'selected' | 'loading' | 'error' | 'empty' | 'required'

export interface NewWorkspaceCreateState {
	online: boolean
	repoStatus: NewWorkspaceRepoStatus
	uploading: boolean
	attachmentError: boolean
	workflowMode: boolean
	hasInitialPrompt: boolean
	workflowReady: boolean
	workflowLoading: boolean
	workflowProblem?: string
}

/** The first thing someone can act on when workspace creation is unavailable. */
export function newWorkspaceDisabledReason(state: NewWorkspaceCreateState): string | null {
	if (!state.online) return 'Reconnect to the relay to continue.'
	if (state.repoStatus === 'loading') return 'Loading repositories…'
	if (state.repoStatus === 'error') return 'Couldn’t load repositories.'
	if (state.repoStatus === 'empty') return 'No Conductor repositories are available.'
	if (state.repoStatus === 'required') return 'Choose a repository to continue.'
	if (state.uploading) return 'Wait for attachments to finish uploading.'
	if (state.attachmentError) return 'Remove failed attachments to continue.'
	if (!state.workflowMode) return null
	if (!state.hasInitialPrompt) return 'Describe what the workflow should accomplish.'
	if (state.workflowLoading) return 'Loading Workflow roles…'
	if (!state.workflowReady) return state.workflowProblem ?? 'Workflow roles are unavailable.'
	return null
}
