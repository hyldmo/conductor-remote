import { ChartPie, FileDiff, MessageSquarePlus, PhoneCall } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { type Command, useRegisterCommands } from '../lib/commands.ts'
import { SETTABLE_STATUSES, workspaceStatusLabel } from '../lib/format.ts'

/** Register the workspace palette while keeping live handlers behind one stable ref. */
export function useWorkspaceCommands({
	statusNow,
	diffOpen,
	canCreateChat,
	canSetStatus,
	hasChat,
	canCall,
	voiceActive,
	setStatus
}: {
	statusNow: string | null
	diffOpen: boolean
	canCreateChat: boolean
	canSetStatus: boolean
	hasChat: boolean
	canCall: boolean
	voiceActive: boolean
	setStatus: (status: string) => Promise<void>
}) {
	const latest = useRef<{
		toggleDiff: () => void
		createChat: () => Promise<void>
		openContext: () => void
		openCall: () => void
	} | null>(null)
	const workspaceCommands = useMemo<Command[]>(() => {
		if (!statusNow) return []
		return [
			{
				id: 'workspace.call',
				label: voiceActive ? 'Open active call' : 'Call this workspace',
				group: 'Workspace',
				icon: PhoneCall,
				keywords: ['voice', 'phone', 'active chat', 'context'],
				enabled: canCall,
				run: () => latest.current?.openCall()
			},
			{
				id: 'workspace.diff',
				label: diffOpen ? 'Hide changes' : 'Show changes',
				group: 'Workspace',
				icon: FileDiff,
				keywords: ['diff', 'files', 'review', 'patch'],
				run: () => latest.current?.toggleDiff()
			},
			{
				id: 'workspace.newChat',
				label: 'New chat',
				group: 'Workspace',
				icon: MessageSquarePlus,
				keywords: ['tab', 'session', 'same files'],
				enabled: canCreateChat,
				run: () => latest.current?.createChat()
			},
			{
				id: 'workspace.context',
				label: 'Context breakdown',
				group: 'Workspace',
				icon: ChartPie,
				keywords: ['tokens', 'window', 'usage'],
				enabled: hasChat,
				run: () => latest.current?.openContext()
			},
			...SETTABLE_STATUSES.map(
				(status): Command => ({
					id: `workspace.status.${status}`,
					label: `Status: ${workspaceStatusLabel(status)}`,
					group: 'Workspace',
					keywords: ['mark', 'move', 'sidebar', 'group'],
					checked: status === statusNow,
					enabled: canSetStatus,
					run: () => {
						if (status !== statusNow) void setStatus(status)
					}
				})
			)
		]
	}, [statusNow, diffOpen, canCreateChat, canSetStatus, hasChat, canCall, voiceActive, setStatus])
	useRegisterCommands('workspace', workspaceCommands)
	return latest
}
